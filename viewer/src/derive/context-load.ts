/** Validated sidecar reader; incomplete or altered evidence is always labelled. */
import { modelCallRecordSchema } from '../../../src/trace/model-call.js';

import {
  NO_CONTEXT,
  SUPPORTED_CONTEXT_VERSIONS,
  type BlobRef,
  type CapturedAudit,
  type CapturedCall,
  type CapturedHeader,
  type ContextBundle,
  type ContextFidelityLevel,
  type InternedBlock,
  type InternedMessage,
  type InternedToolCall,
} from './context.js';

/**
 * Content-addressed string table.
 *
 * Ids are handed out by a content-keyed map rather than by hashing, so identical text
 * always shares an id and no two different strings ever can. Base-36 counters keep the ids
 * two or three characters, which matters when a run references them tens of thousands of
 * times.
 */
export class BlobInterner {
  readonly #ids = new Map<string, string>();
  readonly #blobs: Record<string, string> = {};

  ref(text: string): BlobRef {
    const existing = this.#ids.get(text);
    if (existing !== undefined) return existing;
    const id = this.#ids.size.toString(36);
    this.#ids.set(text, id);
    this.#blobs[id] = text;
    return id;
  }

  table(): Record<string, string> {
    return this.#blobs;
  }

  get size(): number {
    return this.#ids.size;
  }

  /** Total characters held, for the build log. */
  get chars(): number {
    let total = 0;
    for (const value of Object.values(this.#blobs)) total += value.length;
    return total;
  }
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}
function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
function bool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}
function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}
function numbers(value: unknown): number[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is number => typeof entry === 'number')
    : [];
}
function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Tool arguments are shown as JSON, so they are interned already formatted. */
function internJson(interner: BlobInterner, value: unknown): BlobRef {
  try {
    return interner.ref(JSON.stringify(value, null, 2) ?? 'null');
  } catch {
    // A cyclic or otherwise unserializable value. Said out loud rather than dropped.
    return interner.ref('[viewer: arguments could not be serialized as JSON]');
  }
}

function readTextCapture(value: unknown) {
  if (value === undefined) return null;
  const raw = record(value);
  return {
    truncated: bool(raw['truncated']),
    chars: num(raw['chars']),
    redacted: bool(raw['redacted']),
  };
}

function readToolCall(raw: unknown, interner: BlobInterner): InternedToolCall {
  const call = record(raw);
  return {
    id: str(call['id']),
    name: str(call['name']),
    argumentsRef: internJson(interner, call['arguments'] ?? {}),
    truncatedArguments: strings(call['truncatedArguments']),
    redacted: bool(call['redacted']),
    depthCapped: bool(call['depthCapped']),
  };
}

function readBlock(raw: unknown, interner: BlobInterner): InternedBlock {
  const block = record(raw);
  const kind = str(block['kind'], 'unsupported');

  if (kind === 'text' || kind === 'thinking') {
    const common = {
      ref: interner.ref(str(block['text'])),
      truncated: bool(block['truncated']),
      chars: num(block['chars']),
      redacted: bool(block['redacted']),
    };
    return kind === 'text'
      ? { kind: 'text', ...common }
      : { kind: 'thinking', providerRedacted: bool(block['providerRedacted']), ...common };
  }

  if (kind === 'toolCall') {
    const call = readToolCall(block, interner);
    return { kind: 'toolCall', ...call };
  }

  if (kind === 'image') {
    return {
      kind: 'image',
      mimeType: str(block['mimeType'], 'unknown'),
      dataChars: num(block['dataChars']),
    };
  }

  return {
    kind: 'unsupported',
    blockType: str(block['blockType'], kind),
    keys: strings(block['keys']),
    note: str(block['note'], 'unrecognised block'),
  };
}

function readMessage(raw: unknown, interner: BlobInterner): InternedMessage {
  const message = record(raw);
  const rawBlocks = message['blocks'];
  return {
    role: str(message['role'], 'unknown'),
    // Absent on a v1 record. Null carries "not captured" all the way to the UI, which
    // labels it rather than rendering an assistant turn as if it had no tool calls.
    blocks: Array.isArray(rawBlocks)
      ? rawBlocks.map((block) => readBlock(block, interner))
      : null,
    textRef: interner.ref(str(message['text'])),
    toolCallId: typeof message['toolCallId'] === 'string' ? message['toolCallId'] : null,
    toolName: typeof message['toolName'] === 'string' ? message['toolName'] : null,
    isError: typeof message['isError'] === 'boolean' ? message['isError'] : null,
    truncated: bool(message['truncated']),
    omitted: bool(message['omitted']),
    chars: num(message['chars']),
    redacted: bool(message['redacted']),
  };
}

function readHeader(raw: Record<string, unknown>, interner: BlobInterner): CapturedHeader {
  const source = raw['systemPromptSource'];
  return {
    provider: str(raw['provider'], 'unknown'),
    model: str(raw['model'], 'unknown'),
    thinkingLevel: str(raw['thinkingLevel'], 'unknown'),
    systemPromptRef: interner.ref(str(raw['systemPrompt'])),
    systemPromptSource:
      source === 'runtime_session' || source === 'harness_configured' ? source : null,
    harnessSystemPromptRef:
      typeof raw['harnessSystemPrompt'] === 'string'
        ? interner.ref(raw['harnessSystemPrompt'])
        : null,
    initialUserPromptRef:
      typeof raw['initialUserPrompt'] === 'string'
        ? interner.ref(raw['initialUserPrompt'])
        : null,
    toolDefinitions: (Array.isArray(raw['toolDefinitions'])
      ? raw['toolDefinitions']
      : []
    ).map((entry) => {
      const definition = record(entry);
      return {
        name: str(definition['name']),
        description: str(definition['description']),
        parametersRef:
          definition['parameters'] === undefined
            ? null
            : internJson(interner, definition['parameters']),
      };
    }),
    settings: record(raw['settings']),
    redacted: bool(raw['redacted']),
  };
}

function readAudit(raw: Record<string, unknown>): CapturedAudit {
  return {
    headerWritten: bool(raw['headerWritten']),
    inputCount: num(raw['inputCount']),
    outputCount: num(raw['outputCount']),
    traceDecisionCount: num(raw['traceDecisionCount']),
    decisionsMissingInput: numbers(raw['decisionsMissingInput']),
    decisionsMissingOutput: numbers(raw['decisionsMissingOutput']),
    failureCount: num(raw['failureCount']),
    truncatedMessageCount: num(raw['truncatedMessageCount']),
    redactedMessageCount: num(raw['redactedMessageCount']),
    omittedBlockMessageCount: num(raw['omittedBlockMessageCount']),
    complete: bool(raw['complete']),
    note: str(raw['note']),
  };
}

export interface LoadContextOptions {
  /** Distinct `decision_boundary` decisions in the trace, to check the capture against. */
  traceDecisionCount: number;
  expectedRunId?: string;
  traceDecisions?: readonly { decisionIndex: number; contextMessageCount: number }[];
  interner: BlobInterner;
}

/**
 * Parses one run's sidecar. Never throws: an unreadable file becomes a bundle that says it
 * is unreadable, because one bad sidecar must not take down the rest of the corpus any
 * more than one bad trace does.
 */
export function loadContextBundle(
  raw: string | null,
  options: LoadContextOptions,
): ContextBundle {
  if (raw === null) return NO_CONTEXT;

  const lines = raw.split('\n').filter((line) => line.trim() !== '');
  if (lines.length === 0) {
    return {
      ...NO_CONTEXT,
      fidelity: {
        level: 'unreadable',
        sourceVersion: null,
        limitations: [
          'context.jsonl exists but is empty; no model-call evidence can be read.',
        ],
      },
    };
  }

  const { interner } = options;
  const versions = new Set<number>();
  const unreadableLines: string[] = [];
  const byDecision = new Map<number, CapturedCall>();
  let header: CapturedHeader | null = null;
  let audit: CapturedAudit | null = null;
  let headerRunId: string | null = null;
  let auditRunId: string | null = null;

  const callFor = (decisionIndex: number): CapturedCall => {
    const existing = byDecision.get(decisionIndex);
    if (existing !== undefined) return existing;
    const created: CapturedCall = { decisionIndex, input: null, output: null };
    byDecision.set(decisionIndex, created);
    return created;
  };

  for (const [index, line] of lines.entries()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      unreadableLines.push(`line ${index + 1} is not valid JSON`);
      continue;
    }
    const entry = record(parsed);
    const version = num(entry['schemaVersion'], -1);
    if (version !== -1) versions.add(version);

    const validationEntry =
      version === 1
        ? {
            ...entry,
            schemaVersion: 2,
            ...(entry['type'] === 'capture_header'
              ? {
                  systemPromptSource: 'harness_configured',
                  harnessSystemPrompt: str(entry['systemPrompt']),
                  initialUserPrompt: '',
                  settings: entry['settings'] ?? {},
                }
              : {}),
          }
        : entry;
    const validation = modelCallRecordSchema.safeParse(validationEntry);
    if (!validation.success) {
      unreadableLines.push(
        `line ${index + 1} fails schema validation: ${validation.error.issues.map((issue) => issue.path.join('.') + ': ' + issue.message).join('; ')}`,
      );
      continue;
    }
    switch (entry['type']) {
      case 'capture_header':
        if (header !== null) {
          unreadableLines.push('duplicate capture_header');
          break;
        }
        header = readHeader(entry, interner);
        headerRunId = str(entry['runId']);
        break;
      case 'call_input': {
        const call = callFor(num(entry['decisionIndex'], -1));
        if (call.input !== null) {
          unreadableLines.push(`duplicate call_input at D${call.decisionIndex}`);
          break;
        }
        const messages = Array.isArray(entry['capturedModelContext'])
          ? entry['capturedModelContext']
          : [];
        call.input = {
          wallClockIso: str(entry['wallClockIso']),
          messages: messages.map((message) => readMessage(message, interner)),
          messageCount: num(entry['messageCount'], messages.length),
        };
        break;
      }
      case 'call_output': {
        const call = callFor(num(entry['decisionIndex'], -1));
        if (call.output !== null) {
          unreadableLines.push(`duplicate call_output at D${call.decisionIndex}`);
          break;
        }
        const usage = record(entry['usage']);
        const usageNumbers = Object.entries(usage).filter(
          (pair): pair is [string, number] => typeof pair[1] === 'number',
        );
        call.output = {
          wallClockIso: str(entry['wallClockIso']),
          turnIndex: num(entry['turnIndex'], -1),
          textRef: interner.ref(str(entry['text'])),
          reasoningRef:
            typeof entry['reasoningText'] === 'string'
              ? interner.ref(entry['reasoningText'])
              : null,
          reasoningRedacted: bool(entry['reasoningRedacted']),
          textCapture: readTextCapture(entry['textCapture']),
          reasoningCapture: readTextCapture(entry['reasoningCapture']),
          stopReason: str(entry['stopReason'], 'unknown'),
          providerErrorMessage:
            typeof entry['providerErrorMessage'] === 'string'
              ? entry['providerErrorMessage']
              : null,
          toolCalls: (Array.isArray(entry['toolCalls']) ? entry['toolCalls'] : []).map(
            (call) => readToolCall(call, interner),
          ),
          usage: usageNumbers.length === 0 ? null : Object.fromEntries(usageNumbers),
        };
        break;
      }
      case 'capture_audit':
        if (audit !== null) {
          unreadableLines.push('duplicate capture_audit');
          break;
        }
        audit = readAudit(entry);
        auditRunId = str(entry['runId']);
        if (
          Array.isArray(entry['failures']) &&
          entry['failures'].length > audit.failureCount
        )
          unreadableLines.push(
            'capture_audit failureCount is smaller than its failure list',
          );
        break;
      default:
        unreadableLines.push(
          `line ${index + 1} has unrecognised record type ${JSON.stringify(entry['type'])}`,
        );
    }
  }

  const calls = [...byDecision.values()].sort((a, b) => a.decisionIndex - b.decisionIndex);
  const sourceVersions = [...versions].sort();
  const sourceVersion = sourceVersions[0] ?? null;

  if (header === null && calls.length === 0) {
    return {
      fidelity: {
        level: 'unreadable',
        sourceVersion,
        limitations: [
          'context.jsonl held no readable record.',
          ...unreadableLines.slice(0, 5),
        ],
      },
      header: null,
      calls: [],
      audit,
    };
  }

  const limitations: string[] = [];
  if (
    options.expectedRunId !== undefined &&
    ((headerRunId !== null && headerRunId !== options.expectedRunId) ||
      (auditRunId !== null && auditRunId !== options.expectedRunId))
  )
    limitations.push('capture belongs to a different run than its trace.');

  if (sourceVersions.length > 1) {
    limitations.push(
      `records mix schema versions (${sourceVersions.join(', ')}); a sidecar is written ` +
        'by one runner in one pass, so this is a concatenated or corrupted artifact',
    );
  }
  if (
    sourceVersion !== null &&
    !(SUPPORTED_CONTEXT_VERSIONS as readonly number[]).includes(sourceVersion)
  ) {
    limitations.push(
      `written at schema v${sourceVersion}, which this build does not know; fields it ` +
        'added are not shown',
    );
  }
  if (sourceVersion === 1) {
    limitations.push(
      'v1 records: messages were captured as flattened text only. Tool calls, thinking ' +
        'blocks and images inside a message were not recorded, so an assistant turn ' +
        'here cannot be distinguished from one that only spoke.',
    );
    limitations.push('v1 records: no secret redaction was applied on the capture path.');
  }
  if (header === null) {
    limitations.push(
      'no capture_header: the system prompt, tool schemas and run settings for these ' +
        'calls were not recorded (v1 wrote the header only after the run completed).',
    );
  } else if (header.systemPromptSource === 'harness_configured') {
    limitations.push(
      'the system prompt shown is the harness-configured text, not the effective prompt ' +
        'the runtime sent — the runtime appends its own lines below it.',
    );
  } else if (header.systemPromptSource === null) {
    limitations.push(
      'the header does not say whether its system prompt is the effective runtime prompt ' +
        'or the harness-configured one.',
    );
  }

  const withInput = calls.filter((call) => call.input !== null).length;
  const missingInput = Math.max(0, options.traceDecisionCount - withInput);
  if (missingInput > 0) {
    limitations.push(
      `${missingInput} of ${options.traceDecisionCount} decision boundaries in the trace ` +
        'have no captured input.',
    );
  }
  const missingOutput = calls.filter((call) => call.output === null);
  if (missingOutput.length > 0) {
    limitations.push(
      `no captured output at D${missingOutput.map((call) => call.decisionIndex).join(', D')}` +
        ' — expected for the final decision of a run that was aborted, timed out or lost ' +
        'its provider.',
    );
  }
  if (audit !== null && audit.failureCount > 0) {
    limitations.push(
      `the harness recorded ${audit.failureCount} capture failure(s): ${audit.note}`,
    );
  }
  if (audit === null && sourceVersion !== 1) {
    limitations.push(
      'no capture_audit record: the run did not reach the end of its result-writing path, ' +
        'so the harness never stated how complete this capture is.',
    );
  }
  if (unreadableLines.length > 0) {
    limitations.push(
      `${unreadableLines.length} line(s) could not be read: ${unreadableLines
        .slice(0, 3)
        .join('; ')}`,
    );
  }

  const expected =
    options.traceDecisions === undefined
      ? new Map(
          Array.from({ length: options.traceDecisionCount }, (_, i) => [i, undefined]),
        )
      : new Map(
          options.traceDecisions.map((d) => [d.decisionIndex, d.contextMessageCount]),
        );
  if (expected.size !== options.traceDecisionCount)
    limitations.push('trace decision IDs disagree with the trace decision count.');
  for (const [id, count] of expected) {
    const call = byDecision.get(id);
    if (!call?.input) limitations.push(`D${id} has no captured input.`);
    if (!call?.output) limitations.push(`D${id} has no captured output.`);
    if (call?.input && count !== undefined && call.input.messageCount !== count)
      limitations.push(`D${id} message count disagrees with its trace boundary.`);
  }
  // Bounded-content totals, and the decisions they happened at. Aggregated rather than
  // emitted per decision: a 30-decision run that truncated one message should say so once,
  // not print thirty near-identical lines that bury the structural gaps above them.
  let truncatedMessages = 0;
  let redactedMessages = 0;
  let omittedMessages = 0;
  let messagesWithoutBlocks = 0;
  let outputsWithoutCaptureMetadata = 0;
  const boundedInputs = new Set<number>();
  const boundedOutputs = new Set<number>();
  const describedBlocks = new Set<number>();
  const providerWithheldReasoning = new Set<number>();
  if (header?.redacted === true) {
    limitations.push('Captured header content was redacted.');
  }
  const damagedTool = (tool: InternedToolCall): boolean =>
    tool.redacted || tool.depthCapped || tool.truncatedArguments.length > 0;
  for (const call of calls) {
    if (!expected.has(call.decisionIndex))
      limitations.push(`D${call.decisionIndex} is absent from the trace decisions.`);
    if (!call.input)
      limitations.push(`D${call.decisionIndex} output has no matching input.`);
    if (call.input && call.input.messageCount !== call.input.messages.length)
      limitations.push(
        `D${call.decisionIndex} messageCount differs from captured message array length.`,
      );
    for (const message of call.input?.messages ?? []) {
      truncatedMessages += Number(message.truncated);
      redactedMessages += Number(message.redacted);
      omittedMessages += Number(message.omitted);
      // A message with no block structure is a v1 record: the artifact cannot say what
      // else was in it. That is a gap, not bounded content.
      if (message.blocks === null) messagesWithoutBlocks += 1;
      if (
        message.truncated ||
        message.redacted ||
        message.omitted ||
        message.blocks?.some((block) =>
          block.kind === 'text' || block.kind === 'thinking'
            ? block.truncated ||
              block.redacted ||
              (block.kind === 'thinking' && block.providerRedacted)
            : false,
        )
      )
        boundedInputs.add(call.decisionIndex);
      if (
        message.blocks?.some(
          (block) => block.kind === 'image' || block.kind === 'unsupported',
        ) === true
      ) {
        describedBlocks.add(call.decisionIndex);
      }
      if (
        message.blocks?.some((block) => block.kind === 'toolCall' && damagedTool(block)) ===
        true
      ) {
        boundedInputs.add(call.decisionIndex);
      }
    }
    const output = call.output;
    if (output !== null) {
      // The harness records what it did to the assistant text and the reasoning. Its
      // absence means the artifact cannot establish whether
      // either was cut — that is a gap.
      if (
        output.textCapture === null ||
        (output.reasoningRef !== null && output.reasoningCapture === null)
      ) {
        outputsWithoutCaptureMetadata += 1;
      }
      if (
        output.textCapture?.truncated === true ||
        output.textCapture?.redacted === true ||
        output.reasoningCapture?.truncated === true ||
        output.reasoningCapture?.redacted === true ||
        output.toolCalls.some(damagedTool)
      ) {
        boundedOutputs.add(call.decisionIndex);
      }
      if (output.reasoningRedacted) providerWithheldReasoning.add(call.decisionIndex);
    }
  }

  if (messagesWithoutBlocks > 0) {
    limitations.push(
      `${messagesWithoutBlocks} captured message(s) have no block structure, so tool ` +
        'calls, reasoning and images inside them were not recorded.',
    );
  }
  if (outputsWithoutCaptureMetadata > 0) {
    limitations.push(
      `${outputsWithoutCaptureMetadata} captured output(s) lack truncation and redaction ` +
        'metadata, so whether their text was altered cannot be verified.',
    );
  }

  // Intentional capture limits still leave gaps in the evidence presented to a reader.
  if (boundedInputs.size > 0) {
    limitations.push(
      `Input at D${[...boundedInputs].sort((a, b) => a - b).join(', D')} contains truncated, redacted or omitted content.`,
    );
  }
  if (boundedOutputs.size > 0) {
    limitations.push(
      `Output at D${[...boundedOutputs].sort((a, b) => a - b).join(', D')} contains truncated, redacted or omitted content.`,
    );
  }
  if (describedBlocks.size > 0) {
    limitations.push(
      `D${[...describedBlocks].sort((a, b) => a - b).join(', D')} contain image or ` +
        'unrecognised blocks, which are described rather than carried.',
    );
  }
  if (providerWithheldReasoning.size > 0) {
    limitations.push(
      `The provider withheld reasoning text at D` +
        `${[...providerWithheldReasoning].sort((a, b) => a - b).join(', D')}. This is the ` +
        "provider's choice and says nothing about whether the model reasoned.",
    );
  }
  if (truncatedMessages > 0 || redactedMessages > 0 || omittedMessages > 0) {
    limitations.push(
      `Across the run: ${truncatedMessages} message(s) truncated, ${redactedMessages} ` +
        `with a secret redacted, ${omittedMessages} with a described-not-carried block.`,
    );
  }

  if (audit !== null) {
    // These are cross-checks, not restatements: the audit is what the *harness* claims,
    // recomputed here from the records that actually landed. A disagreement means one of
    // the two is wrong and neither should be trusted silently.
    if (headerRunId !== null && headerRunId !== auditRunId) {
      limitations.push('capture_header and capture_audit belong to different runs.');
    }
    if (!audit.complete) {
      limitations.push(`the harness reports an incomplete capture: ${audit.note}`);
    }
    if (
      audit.headerWritten !== (header !== null) ||
      audit.inputCount !== withInput ||
      audit.outputCount !== calls.filter((call) => call.output !== null).length ||
      audit.traceDecisionCount !== options.traceDecisionCount
    ) {
      limitations.push(
        'capture_audit header or call counts disagree with the sidecar or trace.',
      );
    }
    const missing = (half: 'input' | 'output'): number[] =>
      [...expected.keys()]
        .filter((id) => byDecision.get(id)?.[half] == null)
        .sort((a, b) => a - b);
    const sameIds = (a: number[], b: number[]): boolean =>
      JSON.stringify([...a].sort((x, y) => x - y)) === JSON.stringify(b);
    if (
      !sameIds(audit.decisionsMissingInput, missing('input')) ||
      !sameIds(audit.decisionsMissingOutput, missing('output'))
    ) {
      limitations.push(
        'capture_audit missing-decision IDs disagree with the sidecar or trace.',
      );
    }
    if (
      audit.truncatedMessageCount ||
      audit.redactedMessageCount ||
      audit.omittedBlockMessageCount
    )
      limitations.push('the audit reports truncated, redacted or omitted message content.');
    if (
      audit.truncatedMessageCount !== truncatedMessages ||
      audit.redactedMessageCount !== redactedMessages ||
      audit.omittedBlockMessageCount !== omittedMessages
    ) {
      limitations.push(
        'capture_audit content counts disagree with captured message flags.',
      );
    }
  }

  // Fidelity measures preserved evidence, including losses introduced intentionally.
  const level: ContextFidelityLevel = limitations.length === 0 ? 'full' : 'partial';

  return {
    fidelity: {
      level,
      sourceVersion,
      limitations: [...new Set(limitations)],
    },
    header,
    calls,
    audit,
  };
}
