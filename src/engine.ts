import { captureMessage, type CaptureMessageSource } from './harness/capture.js';
import type { RunSandbox } from './harness/sandbox.js';
import { repoSnapshot } from './harness/snapshot.js';
import type { ToolObservation } from './harness/repo-tools.js';
import type { TaskFamily } from './families/types.js';
import {
  NoiseStream,
  scriptFor,
  TEST_COMMAND,
  type Condition,
  type ImportantKind,
} from './scenario.js';
import {
  FORMAT,
  type Context,
  type Event,
  type EventBody,
  type RepoSnapshot,
} from './schema.js';
import type { StateResult, TeamEvent, TeamState } from './state.js';
import type { UsageRecord } from './usage.js';

export async function snapshot(
  sandbox: RunSandbox,
  commit: string,
  family: TaskFamily,
): Promise<RepoSnapshot> {
  const base = await repoSnapshot(sandbox, commit);
  const out = await sandbox.exec([
    'node',
    '--input-type=module',
    '-e',
    `import fs from 'node:fs';import crypto from 'node:crypto';import path from 'node:path';
const [focal,hotfix]=JSON.parse(process.argv[1]);
const read=p=>fs.existsSync(p)&&fs.statSync(p).isFile()?fs.readFileSync(p,'utf8'):null;
const hash=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
const walk=p=>!fs.existsSync(p)?[]:fs.readdirSync(p,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(e=>{const f=path.join(p,e.name);return e.isDirectory()?walk(f):e.isFile()?[[f,fs.readFileSync(f,'utf8')]]:[];});
console.log(JSON.stringify({focalDigest:hash(focal.map(p=>[p,read(p)])),hotfixDigest:hash(hotfix.map(p=>[p,read(p)])),testsDigest:hash(walk('tests'))}));`,
    JSON.stringify([family.focal.paths, family.hotfix.paths]),
  ]);
  if (out.exitCode !== 0 || out.truncated)
    throw Error('Task snapshot failed: ' + out.stderr);
  return { ...base, ...(JSON.parse(out.stdout) as Omit<RepoSnapshot, keyof typeof base>) };
}

export interface AnnotatableMessage {
  role: string;
  content: string | Array<{ type: string; [key: string]: unknown }>;
  toolCallId?: string;
}

export function stripAnnotations(text: string) {
  return text
    .replace(/\n*<environment_status>[\s\S]*?<\/environment_status>/g, '')
    .replace(/\n*<notification>[\s\S]*?<\/notification>/g, '')
    .trim();
}
function append(m: AnnotatableMessage, text: string) {
  if (typeof m.content === 'string') m.content += '\n' + text;
  else m.content.push({ type: 'text', text });
}

export interface Fired {
  kind: ImportantKind;
  eventId: string;
  decision: number;
}

/**
 * Applies environment changes at batch boundaries, or controlled tool boundaries in interrupt
 * mode. Triggers never read hidden checks or model reasoning.
 */
export class Engine {
  readonly trace: Event[] = [];
  readonly context: Context[] = [];
  readonly observations = new Map<string, ToolObservation>();
  readonly observationDecision = new Map<string, number>();
  readonly fired = new Map<ImportantKind, Fired>();
  decision = 0;
  private seenLevels = new Set<string>();
  private anchors = new Map<string, string>();
  private inputs = 0;
  private outputs = 0;
  private partial = false;
  private last: RepoSnapshot;
  private seenModules = new Set<string>();
  private firstFocalEditDecision: number | null = null;
  private noise: NoiseStream;
  private noiseDecision = -1;
  constructor(
    readonly state: TeamState,
    readonly condition: Condition,
    initial: RepoSnapshot,
    private traceSink: (e: Event) => void = () => {},
    private contextSink: (e: Context) => void = () => {},
  ) {
    this.last = initial;
    this.noise = new NoiseStream(state.family, condition.noise, condition.seed);
  }
  emit(body: EventBody) {
    const e = {
      ...body,
      format: FORMAT,
      seq: this.trace.length + 1,
      decision: this.decision,
      at: new Date().toISOString(),
    } as Event;
    this.trace.push(e);
    this.traceSink(e);
  }
  capture(record: Context) {
    this.context.push(record);
    this.contextSink(record);
  }
  private expose(
    eventId: string,
    level: 'cue' | 'content',
    via: string,
    toolCallId?: string,
  ) {
    const key = eventId + ':' + level;
    if (this.seenLevels.has(key)) return;
    this.seenLevels.add(key);
    this.emit({
      type: 'exposure',
      eventId,
      level,
      via,
      ...(toolCallId ? { toolCallId } : {}),
    });
  }
  observe(observation: ToolObservation) {
    this.observations.set(observation.id, observation);
    this.observationDecision.set(observation.id, this.decision);
    this.emit({ type: 'tool_action', observation });
    const effect = observation.effect as StateResult | undefined;
    if (!effect || observation.isError) return;
    const important = (id: string) =>
      this.state.events.some((e) => e.id === id && e.important);
    for (const id of effect.cues ?? [])
      if (important(id)) this.expose(id, 'cue', observation.name, observation.id);
    for (const id of effect.contents ?? [])
      if (important(id)) {
        this.expose(id, 'cue', observation.name, observation.id);
        this.expose(id, 'content', observation.name, observation.id);
      }
  }

  beforeDecision<T extends AnnotatableMessage>(source: readonly T[]): T[] {
    this.decision++;
    const messages = structuredClone(source) as T[];
    const target =
      [...messages].reverse().find((m) => m.role === 'toolResult') ??
      [...messages].reverse().find((m) => m.role === 'user');
    if (!target) throw Error('Missing observation anchor');
    const anchor = target.toolCallId ?? 'initial-user';
    if (this.condition.delivery === 'exposed')
      for (const e of this.state.events)
        if (!this.anchors.has(e.id)) {
          this.anchors.set(e.id, anchor);
          this.state.markDelivered(e.id);
          if (e.important) {
            this.expose(e.id, 'cue', 'exposed');
            this.expose(e.id, 'content', 'exposed');
          }
        }
    for (const m of messages) {
      if (typeof m.content === 'string') m.content = stripAnnotations(m.content);
      else
        m.content = m.content.map((p) =>
          p.type === 'text' && typeof p['text'] === 'string'
            ? { ...p, text: stripAnnotations(p['text']) }
            : p,
        );
      const key = m.toolCallId ?? (m.role === 'user' ? 'initial-user' : '');
      for (const e of this.state.events)
        if (this.anchors.get(e.id) === key)
          append(m, `<notification>\n${e.text}\n</notification>`);
    }
    const status = this.state.indicator();
    append(target, status);
    this.emit({ type: 'input', status, counts: this.state.counts() });
    const captured = messages.map((m) =>
      captureMessage(m as unknown as CaptureMessageSource),
    );
    this.partial ||= captured.some((m) => m.truncated || m.omitted || m.redacted);
    this.capture({ type: 'input', decision: this.decision, messages: captured });
    this.inputs++;
    return messages;
  }

  afterOutput(
    message: unknown,
    info: {
      stopReason: string;
      calls: Array<{ id: string }>;
      errorMessage?: string | undefined;
    },
    usage: UsageRecord | null,
  ) {
    this.emit({
      type: 'output',
      toolCallIds: info.calls.map((c) => c.id),
      stopReason: info.stopReason,
      usage,
      ...(info.errorMessage ? { errorMessage: info.errorMessage } : {}),
    });
    const captured = captureMessage(message as CaptureMessageSource);
    this.partial ||= Boolean(captured.truncated || captured.omitted || captured.redacted);
    this.capture({ type: 'output', decision: this.decision, message: captured });
    this.outputs++;
  }

  /** Settles a batch or an interrupt-mode tool checkpoint. Returns new important events. */
  settle(repo: RepoSnapshot, canContinue = true): TeamEvent[] {
    this.emit({ type: 'snapshot', snapshot: repo });
    const batch = [...this.observations.values()].filter(
      (o) => this.observationDecision.get(o.id) === this.decision,
    );
    const batchTestFailure = batch.some(
      (o) =>
        o.name === 'bash' &&
        TEST_COMMAND.test(String(o.args['command'] ?? '')) &&
        (o.isError || (o.value as { exitCode?: number })?.exitCode !== 0),
    );
    const batchError = batch.some((o) => o.isError);
    const focalEdit = repo.focalDigest !== this.last.focalDigest;
    const hotfixEdit = repo.hotfixDigest !== this.last.hotfixDigest;
    if (focalEdit) this.firstFocalEditDecision ??= this.decision;
    const batchTestRun = batch.some(
      (o) => o.name === 'bash' && TEST_COMMAND.test(String(o.args['command'] ?? '')),
    );
    // Successful explicit source reads/searches, or shell inspection commands mentioning source.
    // Shell recognition is deliberately heuristic; deadlines cover opaque/custom commands.
    const paths = [...this.state.family.focal.paths, ...this.state.family.hotfix.paths];
    const successful = batch.filter(
      (o) =>
        !o.isError &&
        (o.name !== 'bash' || (o.value as { exitCode?: number })?.exitCode === 0),
    );
    const touchedModules = (o: ToolObservation, candidates = paths): string[] => {
      const target = String(o.args['path'] ?? '')
        .replace(/^\/workspace\/repo\//, '')
        .replace(/^\.\//, '');
      if (['read', 'edit', 'write', 'grep'].includes(o.name))
        return candidates.filter(
          (p) =>
            p === target ||
            (o.name === 'grep' &&
              (target === '.' || target === '' || p.startsWith(target + '/'))),
        );
      if (
        o.name === 'bash' &&
        /\b(cat|sed|head|tail|rg|grep)\b/.test(String(o.args['command'] ?? ''))
      )
        return candidates.filter(
          (p) =>
            String(o.args['command']).includes(p) ||
            String(o.args['command']).includes(p.split('/')[0] + '/*'),
        );
      return [];
    };
    const modules = new Set(successful.flatMap((o) => touchedModules(o)));
    const sourceInspection = successful.some(
      (o) =>
        ['read', 'grep', 'bash'].includes(o.name) &&
        touchedModules(o).length > 0 &&
        (o.name !== 'bash' ||
          /\b(cat|sed|head|tail|rg|grep)\b/.test(String(o.args['command'] ?? ''))),
    );
    const newModule = [...modules].some((p) => !this.seenModules.has(p));
    const hotfixInspection = successful.some(
      (o) =>
        ['read', 'grep', 'bash'].includes(o.name) &&
        touchedModules(o).some((p) => this.state.family.hotfix.paths.includes(p)),
    );
    // Agents can inspect all source before an incident is assigned and then fix it in
    // one write. Recognize the intervening switch or test inspection at its own boundary.
    const hotfixTestInspection = successful.some(
      (o) =>
        ['read', 'grep', 'bash'].includes(o.name) &&
        touchedModules(o, this.state.family.hotfix.testPaths ?? []).length > 0,
    );
    const hotfixStarted = successful.some(
      (o) =>
        o.name === 'linear_update_issue_status' &&
        String(o.args['id'] ?? '')
          .trim()
          .toUpperCase() === this.state.family.hotfix.id &&
        o.args['status'] === 'in_progress',
    );
    const incident = this.fired.get('urgent_assignment');
    const incidentRetrieved =
      incident !== undefined && this.seenLevels.has(incident.eventId + ':content');
    for (const p of modules) this.seenModules.add(p);
    this.last = repo;
    // A terminal response has no following decision in which to observe new events.
    if (!canContinue) return [];
    const published: TeamEvent[] = [];
    for (const step of scriptFor(this.condition)) {
      if (this.fired.has(step.kind)) continue;
      const anchor =
        step.trigger.after === 'start' ? 0 : this.fired.get(step.trigger.after)?.decision;
      if (anchor === undefined) break;
      const gap = this.decision - anchor;
      const met =
        step.trigger.when === 'source_inspection'
          ? sourceInspection
          : step.trigger.when === 'focal_edit'
            ? focalEdit
            : step.trigger.when === 'test_run'
              ? batchTestRun
              : step.trigger.when === 'hotfix_work'
                ? incidentRetrieved &&
                  (hotfixStarted || hotfixTestInspection || hotfixEdit || hotfixInspection)
                : step.trigger.when === 'focal_done'
                  ? this.state.current(this.state.family.focal.id)?.status === 'done'
                  : newModule;
      const mode =
        gap >= step.trigger.minGap && met
          ? 'condition'
          : step.trigger.fallbackGap !== undefined && gap >= step.trigger.fallbackGap
            ? 'fallback'
            : null;
      if (mode) {
        const event = this.state.publishImportant(step.kind);
        this.fired.set(step.kind, {
          kind: step.kind,
          eventId: event.id,
          decision: this.decision,
        });
        this.emit({
          type: 'environment_event',
          event,
          trigger: {
            mode,
            when: step.trigger.when,
            batchTestFailure,
            batchError,
            sourceInspection,
            focalEdit,
            hotfixEdit,
            hotfixInspection,
            hotfixTestInspection,
            hotfixStarted,
            firstFocalEditDecision: this.firstFocalEditDecision,
            batchTestRun,
            newModule,
          },
        });
        published.push(event);
        // Mixed-priority bundle: the important message shares the boundary with one seeded
        // low-priority item. Empty at noise=none; ordered after the important event so retrieval
        // semantics (requirement-before-comment, important cue first) stay untouched.
        for (const item of this.noise.bundle()) {
          const bundled = this.state.publishNoise(item);
          this.emit({
            type: 'environment_event',
            event: bundled,
            trigger: {
              mode: 'noise',
              when: step.trigger.when,
              batchTestFailure,
              batchError,
              bundled: true,
            },
          });
        }
      }
    }
    // Interrupt mode may settle several tools in one decision. Never multiply noise
    // draws with the number of inner calls in a native code-mode batch.
    const drawNoise = this.noiseDecision !== this.decision;
    this.noiseDecision = this.decision;
    for (const item of drawNoise ? this.noise.draw(batchTestFailure || batchError) : []) {
      const event = this.state.publishNoise(item);
      this.emit({
        type: 'environment_event',
        event,
        trigger: { mode: 'noise', batchTestFailure, batchError },
      });
    }
    return published;
  }

  close(note = 'Pi runtime context seam; no provider wire-payload claim.') {
    const complete = this.inputs > 0 && this.inputs === this.outputs;
    this.capture({
      type: 'audit',
      inputs: this.inputs,
      outputs: this.outputs,
      complete,
      partialContent: this.partial,
      note,
    });
    return { complete, partialContent: this.partial };
  }
}
