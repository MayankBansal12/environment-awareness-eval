import type { AnnotatableMessage } from '../engine/environment.js';
import { captureMessage, type CaptureMessageSource } from '../trace/model-call.js';
import type { ToolObservation } from '../v2/tools.js';
import type { RunSandbox } from '../v2/sandbox.js';
import { snapshot as baseSnapshot } from '../v2/engine.js';
import { A, B, TeamState } from './state.js';
import type { Context, Event, EventBody, RepoSnapshot } from './schema.js';

export async function snapshot(sandbox: RunSandbox, commit: string): Promise<RepoSnapshot> {
  const base = await baseSnapshot(sandbox, commit);
  const out = await sandbox.exec([
    'node',
    '--input-type=module',
    '-e',
    `import fs from 'node:fs';import crypto from 'node:crypto';
 const hash=files=>crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex');
 const walk=p=>!fs.existsSync(p)?[]:fs.readdirSync(p,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name)).flatMap(e=>{const f=p+'/'+e.name;return e.isDirectory()?walk(f):e.isFile()?[[f,fs.readFileSync(f,'utf8')]]:[[f,'non-regular']];});
 const tests=walk('tests');console.log(JSON.stringify({taskDigests:{A:hash(walk('src/history')),B:hash(walk('src/recovery'))},testDigests:{A:hash(tests.filter(([p])=>p.includes('history'))),B:hash(tests.filter(([p])=>p.includes('recovery')))}}));`,
  ]);
  if (out.exitCode !== 0 || out.truncated)
    throw Error('Task snapshot failed: ' + out.stderr);
  return { ...base, ...JSON.parse(out.stdout) } as RepoSnapshot;
}
export function stripAnnotations(text: string) {
  return text
    .replace(/\n*<environment_status>[\s\S]*?<\/environment_status>/g, '')
    .replace(/\n*<task_event>[\s\S]*?<\/task_event>/g, '')
    .trim();
}
function append(m: AnnotatableMessage, text: string) {
  if (typeof m.content === 'string') m.content += '\n' + text;
  else m.content.push({ type: 'text', text });
}

export class Engine {
  readonly trace: Event[] = [];
  readonly context: Context[] = [];
  readonly observations = new Map<string, ToolObservation>();
  decision = 0;
  checkpoint: { decision: number; responseOpportunity: boolean } | undefined;
  private seen = new Set<string>();
  private ticketRead = false;
  private codeRead = false;
  private inputs = 0;
  private outputs = 0;
  private partial = false;
  private anchors = new Map<string, string>();
  private initial: RepoSnapshot;
  constructor(
    readonly state: TeamState,
    initial: RepoSnapshot,
    private traceSink: (e: Event) => void = () => {},
    private contextSink: (e: Context) => void = () => {},
  ) {
    this.initial = initial;
  }
  emit(body: EventBody) {
    const e: Event = {
      ...body,
      format: 'environment-v3',
      seq: this.trace.length + 1,
      decision: this.decision,
      at: new Date().toISOString(),
    };
    this.trace.push(e);
    this.traceSink(e);
  }
  capture(record: Context) {
    this.context.push(record);
    this.contextSink(record);
  }
  observe(observation: ToolObservation) {
    this.observations.set(observation.id, observation);
    this.emit({ type: 'tool_action', observation });
  }
  beforeDecision<T extends AnnotatableMessage>(source: readonly T[]): T[] {
    this.decision++;
    const messages = structuredClone(source) as T[];
    for (const m of messages)
      if (m.role === 'toolResult' && m.toolCallId && !this.seen.has(m.toolCallId)) {
        this.seen.add(m.toolCallId);
        const o = this.observations.get(m.toolCallId);
        if (!o || o.isError) continue;
        if (o.name === 'get_ticket' && o.args['id'] === A) this.ticketRead = true;
        if (
          ['read', 'grep', 'bash'].includes(o.name) &&
          /class TransactionHistory/.test(JSON.stringify(o.value))
        )
          this.codeRead = true;
      }
    const target =
      [...messages].reverse().find((m) => m.role === 'toolResult') ??
      [...messages].reverse().find((m) => m.role === 'user');
    if (!target) throw Error('Missing observation anchor');
    for (const e of this.state.events)
      if (
        (this.state.delivery === 'exposed' || e.kind === 'reminder') &&
        !this.anchors.has(e.id)
      )
        this.anchors.set(e.id, target.toolCallId ?? 'initial-user');
    for (const m of messages) {
      if (typeof m.content === 'string') m.content = stripAnnotations(m.content);
      else
        m.content = m.content.map((p) =>
          p.type === 'text' && typeof p['text'] === 'string'
            ? { ...p, text: stripAnnotations(p['text']) }
            : p,
        );
      const anchor = m.toolCallId ?? (m.role === 'user' ? 'initial-user' : '');
      for (const e of this.state.events)
        if (this.anchors.get(e.id) === anchor)
          append(m, `<task_event>\n${e.text}\n</task_event>`);
    }
    const status = this.state.indicator();
    append(target, status);
    this.emit({ type: 'input', status });
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
    info: { stopReason: string; calls: Array<{ id: string }> },
  ) {
    this.emit({
      type: 'output',
      toolCallIds: info.calls.map((c) => c.id),
      stopReason: info.stopReason,
    });
    const captured = captureMessage(message as CaptureMessageSource);
    this.partial ||= Boolean(captured.truncated || captured.omitted || captured.redacted);
    this.capture({ type: 'output', decision: this.decision, message: captured });
    this.outputs++;
  }
  settle(repo: RepoSnapshot) {
    this.emit({ type: 'snapshot', snapshot: repo });
    if (
      !this.checkpoint &&
      this.ticketRead &&
      this.codeRead &&
      repo.taskDigests.A !== this.initial.taskDigests.A
    ) {
      this.checkpoint = {
        decision: this.decision,
        responseOpportunity:
          repo.commits.length === 0 && this.state.current(A)?.status !== 'done',
      };
      this.emit({
        type: 'checkpoint',
        responseOpportunity: this.checkpoint.responseOpportunity,
      });
    }
    if (
      !this.state.current(B) &&
      ((this.state.sequence === 'sequential' && this.state.current(A)?.status === 'done') ||
        (this.state.sequence !== 'sequential' && this.checkpoint))
    ) {
      this.emit({ type: 'environment_event', event: this.state.publish('assignment') });
    }
    const assignment = this.trace.find(
      (e) => e.type === 'environment_event' && e.event.kind === 'assignment',
    );
    if (
      this.state.sequence === 'changed' &&
      assignment &&
      assignment.decision < this.decision &&
      repo.taskDigests.B !== this.initial.taskDigests.B &&
      !this.state.events.some((e) => e.kind === 'revision')
    )
      this.emit({ type: 'environment_event', event: this.state.publish('revision') });
    if (
      this.state.sequence === 'reminded' &&
      this.state.current(B)?.status === 'done' &&
      !this.state.events.some((e) => e.kind === 'reminder')
    )
      this.emit({ type: 'environment_event', event: this.state.publish('reminder') });
  }
  close() {
    const complete = this.inputs > 0 && this.inputs === this.outputs;
    this.capture({
      type: 'audit',
      inputs: this.inputs,
      outputs: this.outputs,
      complete,
      partialContent: this.partial,
      note: 'Pi runtime context seam; no provider wire-payload claim.',
    });
    return {
      complete,
      partialContent: this.partial,
      inputs: this.inputs,
      outputs: this.outputs,
    };
  }
}
