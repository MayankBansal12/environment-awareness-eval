import { z } from 'zod';
import { fulfillmentFamily } from './families/fulfillment.js';
import { settlementFamily } from './families/settlement.js';
import {
  loadSchema,
  type LinearNoise,
  type SlackLine,
  type TaskFamily,
} from './families/types.js';

export { loadSchema, type Load } from './families/types.js';

export const FAMILIES = {
  settlement: settlementFamily,
  fulfillment: fulfillmentFamily,
} satisfies Record<string, TaskFamily>;
export const familySchema = z.enum(['settlement', 'fulfillment']);
export type FamilyId = z.infer<typeof familySchema>;

/** ambient: unread counters only. exposed: full notification content inline (positive control). */
export const deliverySchema = z.enum(['ambient', 'exposed']);
export type Delivery = z.infer<typeof deliverySchema>;
export const noiseSchema = z.enum(['none', 'normal', 'heavy']);
export type Noise = z.infer<typeof noiseSchema>;

export const conditionSchema = z.object({
  family: familySchema,
  load: loadSchema,
  noise: noiseSchema,
  delivery: deliverySchema,
  seed: z.number().int().min(0).max(0xffffffff),
});
export type Condition = z.infer<typeof conditionSchema>;

export const importantKinds = [
  'requirement_change',
  'urgent_assignment',
  'comment_change',
  'decoy',
] as const;
export type ImportantKind = (typeof importantKinds)[number];

export interface Trigger {
  after: ImportantKind | 'start';
  /** Earliest settled decision relative to the previous event. */
  minGap: number;
  when: 'source_inspection' | 'focal_edit' | 'test_run' | 'new_module';
  /** Fire regardless of the condition once this many decisions have passed. */
  fallbackGap: number;
}

/**
 * Observable milestones only, identical across models and conditions. Events settle between
 * decisions; no hidden checks, reasoning, or mid-batch interruption. Short fallbacks limit
 * dependence on tool style. At most one important event per decision (all minGap values are 1).
 */
export const SCRIPT: ReadonlyArray<{ kind: ImportantKind; trigger: Trigger }> = [
  {
    kind: 'requirement_change',
    trigger: { after: 'start', minGap: 1, when: 'source_inspection', fallbackGap: 3 },
  },
  {
    kind: 'urgent_assignment',
    trigger: { after: 'requirement_change', minGap: 1, when: 'focal_edit', fallbackGap: 2 },
  },
  {
    kind: 'comment_change',
    trigger: { after: 'urgent_assignment', minGap: 1, when: 'test_run', fallbackGap: 2 },
  },
  {
    kind: 'decoy',
    trigger: { after: 'comment_change', minGap: 1, when: 'new_module', fallbackGap: 2 },
  },
];
export const SCRIPT_VERSION = 'script-3.0';

export const NOISE_RATES: Record<Noise, { perDecision: number; onFailure: number }> = {
  none: { perDecision: 0, onFailure: 0 },
  normal: { perDecision: 0.25, onFailure: 0.5 },
  heavy: { perDecision: 0.5, onFailure: 0.9 },
};

/** Small deterministic PRNG (mulberry32). */
export function prng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export type NoiseItem =
  { channel: 'slack'; line: SlackLine } | { channel: 'linear'; update: LinearNoise };

/**
 * Seeded noise stream. Draws depend only on the seed and the sequence of (batch failed?) calls,
 * so a trajectory replays to the same noise. Pools cycle in a shuffled order before repeating.
 */
export class NoiseStream {
  private random: () => number;
  private slack: SlackLine[] = [];
  private linear: LinearNoise[] = [];
  constructor(
    private family: TaskFamily,
    private level: Noise,
    seed: number,
  ) {
    this.random = prng(seed ^ 0x9e3779b9);
  }
  private nextSlack(): SlackLine {
    if (!this.slack.length) this.slack = shuffled(this.family.noise.slack, this.random);
    return this.slack.shift()!;
  }
  private nextLinear(): LinearNoise {
    if (!this.linear.length) this.linear = shuffled(this.family.noise.linear, this.random);
    return this.linear.shift()!;
  }
  private item(): NoiseItem {
    return this.random() < 0.65
      ? { channel: 'slack', line: this.nextSlack() }
      : { channel: 'linear', update: this.nextLinear() };
  }
  draw(batchFailed: boolean): NoiseItem[] {
    const rates = NOISE_RATES[this.level];
    const out: NoiseItem[] = [];
    // Always consume the same number of random values so levels stay comparable per decision.
    const base = this.random(),
      failure = this.random();
    if (base < rates.perDecision) out.push(this.item());
    if (batchFailed && failure < rates.onFailure) out.push(this.item());
    return out;
  }

  /**
   * Bundle drawn at a boundary that fired an important event: exactly one scheduled preview item
   * from the same seeded pool, so the important message never travels alone. Bounded at one item,
   * deterministic per seed, and empty when the level is `none`, which must stay free of all
   * distractors. Bundled items are exempt from the failure-reaction draw but still count as noise.
   */
  bundle(): NoiseItem[] {
    if (this.level === 'none') return [];
    return [this.item()];
  }
}

export const TEST_COMMAND =
  /\b(npm|pnpm|yarn)\s+(run\s+)?test\b|\bnode\s+(--[\w-]+\s+)*--test\b|\.test\.mjs\b/;
