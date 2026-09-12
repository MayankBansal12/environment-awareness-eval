import {
  captureMessage,
  captureText,
  type CaptureMessageSource,
} from '../trace/model-call.js';
import { messageText, type AnnotatableMessage } from '../engine/environment.js';
import { CANCEL_TEXT, TeamState } from './state.js';
import {
  eventSchema,
  contextSchema,
  snapshotSchema,
  type Snapshot,
  type V2Event,
  type EventInput,
  type V2Context,
} from './schema.js';
import type { ToolObservation } from './tools.js';
import type { RunSandbox } from './sandbox.js';

const SNAPSHOT_SCRIPT = `
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {execFileSync} from 'node:child_process';
const files=[]; let visits=0;
function walk(p){if(++visits>5000)throw Error('Workspace file limit exceeded');if(!fs.existsSync(p))return;const st=fs.lstatSync(p);if(st.isSymbolicLink()){files.push([p,fs.readlinkSync(p)]);return;}if(st.isDirectory()){for(const n of fs.readdirSync(p).sort())if(!['.git','node_modules'].includes(n))walk(path.join(p,n));}else if(st.isFile()){if(st.size>2000000)throw Error('Source file limit exceeded');files.push([p,fs.readFileSync(p,'utf8')]);}}
walk('.');
const hash=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
const git=args=>execFileSync('git',['-c','core.hooksPath=/dev/null',...args],{encoding:'utf8',maxBuffer:1000000}).trim();
const status=git(['status','--porcelain=v1']);
console.log(JSON.stringify({digest:hash(files),implementationDigest:hash(files.filter(([p])=>p.startsWith('src/'))),commits:git(['rev-list',process.argv[1]+'..HEAD']).split('\\n').filter(Boolean),status,changedPaths:git(['diff','--name-only',process.argv[1]]).split('\\n').filter(Boolean)}));
`;
export async function snapshot(sandbox: RunSandbox, commit: string): Promise<Snapshot> {
  const result = await sandbox.exec([
    'node',
    '--input-type=module',
    '-e',
    SNAPSHOT_SCRIPT,
    commit,
  ]);
  if (result.exitCode !== 0 || result.truncated)
    throw new Error('Cannot capture repository state: ' + result.stderr);
  return snapshotSchema.parse(JSON.parse(result.stdout));
}

export class V2Engine {
  readonly trace: V2Event[] = [];
  readonly context: V2Context[] = [];
  readonly observations = new Map<string, ToolObservation>();
  decision = 0;
  checkpoint: { decision: number; responseOpportunity: boolean } | undefined;
  private ticketRetrieved = false;
  private codeRetrieved = false;
  private seenResults = new Set<string>();
  private exposedAnchor: string | undefined;
  private inputs = 0;
  private outputs = 0;
  private partialContent = false;
  private initial: Snapshot;
  constructor(
    readonly state: TeamState,
    initial: Snapshot,
    private traceSink: (event: V2Event) => void = () => {},
    private contextSink: (record: V2Context) => void = () => {},
  ) {
    this.initial = initial;
  }
  emit(input: EventInput): void {
    const event = eventSchema.parse({
      ...input,
      schemaVersion: 2,
      format: 'environment-v2',
      seq: this.trace.length + 1,
      decision: this.decision,
      at: new Date().toISOString(),
    });
    this.trace.push(event);
    this.traceSink(event);
  }
  capture(record: V2Context): void {
    const parsed = contextSchema.parse(record);
    this.context.push(parsed);
    this.contextSink(parsed);
  }
  observe(observation: ToolObservation): void {
    this.observations.set(observation.id, observation);
    this.emit({
      type: 'tool_action',
      id: observation.id,
      name: observation.name,
      args: observation.args,
      value: observation.value,
      isError: observation.isError,
      ...(observation.effect?.statusAttempt
        ? { statusAttempt: observation.effect.statusAttempt }
        : {}),
    });
  }
  beforeDecision<T extends AnnotatableMessage>(source: readonly T[]): T[] {
    this.decision++;
    const messages = structuredClone(source) as T[];
    const sources: string[] = [];
    for (const message of messages) {
      if (
        message.role !== 'toolResult' ||
        !message.toolCallId ||
        this.seenResults.has(message.toolCallId)
      )
        continue;
      const observation = this.observations.get(message.toolCallId);
      if (!observation) continue;
      this.seenResults.add(message.toolCallId);
      if (!observation.isError) {
        this.ticketRetrieved ||= observation.effect?.initialTicketRead === true;
        this.codeRetrieved ||= observation.codeRetrieved;
        if (observation.effect?.exposesCancellation && observation.effect.source) {
          sources.push(observation.effect.source);
          this.emit({
            type: 'exposure',
            kind: 'content',
            source: observation.effect.source,
            toolCallId: message.toolCallId,
          });
        }
      }
    }
    const target =
      [...messages].reverse().find((m) => m.role === 'toolResult') ??
      [...messages].reverse().find((m) => m.role === 'user');
    if (!target) throw new Error('No observation anchor available');
    const anchor = target.toolCallId ?? 'initial-user';
    if (this.checkpoint && this.state.condition === 'exposed' && !this.exposedAnchor) {
      this.exposedAnchor = anchor;
      sources.push('exposed');
      this.emit({ type: 'exposure', kind: 'content', source: 'exposed' });
    }
    // Rebuild only our annotations; ticket tool payloads and previous state snapshots remain untouched.
    for (const message of messages) {
      const clean = (text: string) =>
        text
          .replace(/\n*<environment_status>[\s\S]*?<\/environment_status>/g, '')
          .replace(/\n*<ticket_event>[\s\S]*?<\/ticket_event>/g, '');
      if (typeof message.content === 'string') message.content = clean(message.content);
      else
        message.content = message.content.map((p) =>
          p.type === 'text' && typeof p['text'] === 'string'
            ? { ...p, text: clean(p['text']) }
            : p,
        );
      if (
        (message.toolCallId ?? (message.role === 'user' ? 'initial-user' : '')) ===
        this.exposedAnchor
      )
        append(message, `<ticket_event>\n${CANCEL_TEXT}\n</ticket_event>`);
    }
    const status = this.state.indicator();
    append(target, status);
    const counts = this.state.counts();
    if (counts.linear > 0)
      this.emit({ type: 'exposure', kind: 'indicator', source: 'linear' });
    if (counts.slack > 0)
      this.emit({ type: 'exposure', kind: 'indicator', source: 'slack' });
    this.emit({
      type: 'decision_input',
      status,
      contentSources: sources,
      messageCount: messages.length,
    });
    const captured = messages.map((m) =>
      captureMessage(m as unknown as CaptureMessageSource),
    );
    this.partialContent ||= captured.some(
      (m) => m.truncated || m.omitted === true || m.redacted === true,
    );
    this.capture({ type: 'input', decision: this.decision, messages: captured });
    this.inputs++;
    return messages;
  }
  afterOutput(
    message: unknown,
    info: {
      text: string;
      stopReason: string;
      calls: Array<{ id: string }>;
      usage: Record<string, number> | undefined;
    },
  ): void {
    this.emit({
      type: 'decision_output',
      text: captureText(info.text).text,
      stopReason: info.stopReason,
      toolCallIds: info.calls.map((c) => c.id),
      ...(info.usage ? { usage: info.usage } : {}),
    });
    const captured = captureMessage(message as CaptureMessageSource);
    this.partialContent ||=
      captured.truncated || captured.omitted === true || captured.redacted === true;
    this.capture({ type: 'output', decision: this.decision, message: captured });
    this.outputs++;
  }
  settle(state: Snapshot): void {
    this.emit({ type: 'snapshot', snapshot: state });
    if (
      this.checkpoint ||
      !this.ticketRetrieved ||
      !this.codeRetrieved ||
      state.implementationDigest === this.initial.implementationDigest
    )
      return;
    this.checkpoint = {
      decision: this.decision,
      responseOpportunity: state.commits.length === 0,
    };
    const before = this.state.current();
    const eventCreated = this.state.cancel();
    this.emit({
      type: 'checkpoint',
      ...this.checkpoint,
      eventCreated,
      ticket: this.state.current(),
    });
    if (eventCreated)
      this.emit({
        type: 'ticket_changed',
        before,
        after: this.state.current(),
        slackCreated: this.state.condition === 'linear-slack',
      });
  }
  audit() {
    const complete = this.inputs === this.outputs && this.inputs > 0;
    this.capture({
      type: 'audit',
      inputs: this.inputs,
      outputs: this.outputs,
      complete,
      partialContent: this.partialContent,
      note: 'Captured Pi runtime context, not serialized provider payload. Record coverage and text fidelity are separate.',
    });
    return {
      complete,
      partialContent: this.partialContent,
      inputs: this.inputs,
      outputs: this.outputs,
    };
  }
}
function append(message: AnnotatableMessage, text: string): void {
  if (typeof message.content === 'string') message.content += '\n' + text;
  else message.content.push({ type: 'text', text });
}
export function contextContains(
  source: readonly AnnotatableMessage[],
  text: string,
): boolean {
  return source.some((m) => messageText(m).includes(text));
}
