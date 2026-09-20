import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from './harness/identity.js';
import { matchesRuntimeIdentity } from './harness/model.js';
import { contextSchema, FORMAT, type Audit, type Context, type Event } from './schema.js';
import type { TeamSnapshot } from './state.js';

export const FILES = [
  'trace.jsonl',
  'context.jsonl',
  'team-state.json',
  'workspace.diff',
  'evidence.json',
  'runtime.json',
  'usage.json',
];

/** Replays persisted records only; it never instantiates the engine or team state. */
export function inspect(trace: Event[], context: Context[], team?: TeamSnapshot): Audit {
  const checks: Audit['checks'] = [];
  const check = (id: string, passed: boolean) => checks.push({ id, passed });
  const start = trace.filter((e) => e.type === 'run_start');
  const inputs = context.filter((c) => c.type === 'input'),
    outputs = context.filter((c) => c.type === 'output');
  const frames = trace.filter((e) => e.type === 'input'),
    outFrames = trace.filter((e) => e.type === 'output');
  check(
    'required_records',
    start.length === 1 &&
      context.filter((c) => c.type === 'header').length === 1 &&
      trace.filter((e) => e.type === 'termination').length === 1 &&
      context.filter((c) => c.type === 'audit').length === 1 &&
      inputs.length > 0,
  );
  check(
    'chronology',
    trace.every(
      (e, i) =>
        e.format === FORMAT &&
        e.seq === i + 1 &&
        Number.isInteger(e.decision) &&
        (!i ||
          (e.decision >= trace[i - 1]!.decision &&
            Date.parse(e.at) >= Date.parse(trace[i - 1]!.at))),
    ),
  );
  check(
    'decision_pairing',
    inputs.length === outputs.length &&
      frames.length === inputs.length &&
      outFrames.length === outputs.length &&
      inputs.every((c, i) => c.decision === i + 1 && frames[i]?.decision === i + 1),
  );
  const runtime = start[0]?.type === 'run_start' ? start[0].runtime : undefined;
  check('selected_model_identity', matchesRuntimeIdentity(runtime));
  const header = context.find((c) => c.type === 'header');
  check(
    'neutral_prompt',
    header?.type === 'header' &&
      header.systemPrompt.includes('/workspace/repo') &&
      !/environment_status|unread|priorit|notification/i.test(header.systemPrompt),
  );
  // Every input frame shows the recorded indicator (captures truncated at the cap are exempt).
  check(
    'indicator_delivery',
    inputs.every((c) => {
      const frame = frames.find((f) => f.decision === c.decision);
      if (frame?.type !== 'input') return false;
      const shown = c.messages.filter((m) => m.text.includes('<environment_status>'));
      return (
        (shown.length === 1 && shown[0]!.text.includes(frame.status)) ||
        (shown.length === 0 && c.messages.some((m) => m.truncated))
      );
    }),
  );
  const fired = trace.filter((e) => e.type === 'environment_event');
  check(
    'exposure_after_event',
    trace.every(
      (e) =>
        e.type !== 'exposure' ||
        fired.some(
          (f) =>
            f.type === 'environment_event' &&
            f.event.id === e.eventId &&
            f.decision < e.decision,
        ),
    ),
  );
  check(
    'events_between_decisions',
    fired.every((f) =>
      trace.some(
        (e) => e.type === 'snapshot' && e.decision === f.decision && e.seq < f.seq,
      ),
    ),
  );
  if (team)
    check(
      'team_events_recorded',
      JSON.stringify(team.events.map((e) => e.id)) ===
        JSON.stringify(
          fired.flatMap((f) => (f.type === 'environment_event' ? [f.event.id] : [])),
        ),
    );
  const delivery = start[0]?.type === 'run_start' ? start[0].condition.delivery : undefined;
  check(
    'delivery_mode',
    delivery !== 'exposed'
      ? inputs.every((c) => c.messages.every((m) => !m.text.includes('<notification>')))
      : fired.every((f) => {
          if (f.type !== 'environment_event') return true;
          const next = inputs.find((c) => c.decision === f.decision + 1);
          return (
            !next ||
            next.messages.some(
              (m) => m.truncated || m.text.includes(f.event.text.slice(0, 200)),
            )
          );
        }),
  );
  if (delivery === 'interrupt') {
    const requested = trace.filter(
      (e) => e.type === 'interruption' && e.phase === 'requested',
    );
    const resumed = trace.filter((e) => e.type === 'interruption' && e.phase === 'resumed');
    check(
      'interruptions_paired',
      requested.length === resumed.length &&
        requested.every(
          (r) =>
            r.type === 'interruption' &&
            resumed.some(
              (s) => s.type === 'interruption' && s.turnId === r.turnId && s.seq > r.seq,
            ),
        ),
    );
    check(
      'interruptions_follow_events',
      requested.every(
        (r) =>
          r.type === 'interruption' &&
          r.eventIds.length > 0 &&
          r.eventIds.every((id) =>
            fired.some(
              (f) => f.event.id === id && f.seq < r.seq && f.decision === r.decision,
            ),
          ),
      ),
    );
    check(
      'interrupt_event_coverage',
      fired.every((f) =>
        requested.some(
          (r) =>
            r.type === 'interruption' &&
            r.eventIds.includes(f.event.id) &&
            r.decision === f.decision,
        ),
      ),
    );
    check(
      'no_actions_after_interrupt',
      requested.every(
        (r) =>
          !trace.some(
            (e) =>
              e.type === 'tool_action' &&
              !e.observation.isError &&
              e.decision === r.decision &&
              e.seq > r.seq,
          ),
      ),
    );
    check(
      'interrupt_response_opportunity',
      resumed.every((r) => inputs.some((i) => i.decision === r.decision + 1)),
    );
  }
  return { eligible: checks.every((c) => c.passed), checks, hashes: {} };
}

export async function seal(dir: string, extra: string[] = []) {
  const hashes: Record<string, string> = {};
  for (const name of [...FILES, ...extra])
    hashes[name] = sha256(await readFile(path.join(dir, name)));
  await writeFile(
    path.join(dir, 'integrity.json'),
    JSON.stringify({ version: '4.0', hashes }, null, 2) + '\n',
    { flag: 'wx' },
  );
}

export async function auditRun(dir: string): Promise<Audit> {
  try {
    const lines = async (name: string) =>
      (await readFile(path.join(dir, name), 'utf8'))
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as unknown);
    const trace = (await lines('trace.jsonl')) as Event[];
    const context = (await lines('context.jsonl')).map((c) => contextSchema.parse(c));
    const team = JSON.parse(
      await readFile(path.join(dir, 'team-state.json'), 'utf8'),
    ) as TeamSnapshot;
    const audit = inspect(trace, context, team);
    const receipt = JSON.parse(
      await readFile(path.join(dir, 'integrity.json'), 'utf8'),
    ) as {
      hashes: Record<string, string>;
    };
    for (const name of [...new Set([...FILES, ...Object.keys(receipt.hashes)])]) {
      if (name.startsWith('/') || name.split('/').includes('..'))
        throw Error('Invalid evidence path');
      const hash = sha256(await readFile(path.join(dir, name)));
      audit.hashes[name] = hash;
      audit.checks.push({ id: 'hash:' + name, passed: hash === receipt.hashes[name] });
    }
    audit.eligible = audit.checks.every((c) => c.passed);
    return audit;
  } catch (e) {
    return {
      eligible: false,
      checks: [{ id: 'readable_evidence', passed: false, detail: String(e) }],
      hashes: {},
    };
  }
}
