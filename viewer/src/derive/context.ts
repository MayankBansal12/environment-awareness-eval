/**
 * The captured model context, as the viewer holds it.
 *
 * The v4 capture adapter supplies the original inspector's interned presentation model.
 * Repeated bodies share an id within a run. Missing or altered capture carries explicit
 * fidelity limitations, independently of the behavioral grade.
 */

/** An id into the per-run body table returned by capturedContext. */
export type BlobRef = string;

export type InternedBlock =
  | {
      kind: 'text';
      ref: BlobRef;
      truncated: boolean;
      chars: number;
      redacted: boolean;
    }
  | {
      kind: 'thinking';
      ref: BlobRef;
      /** The provider's own safety redaction, not the harness's secret scrub. */
      providerRedacted: boolean;
      truncated: boolean;
      chars: number;
      redacted: boolean;
    }
  | {
      kind: 'toolCall';
      id: string;
      name: string;
      /** Pretty-printed JSON arguments, interned. */
      argumentsRef: BlobRef;
      truncatedArguments: string[];
      redacted: boolean;
      depthCapped: boolean;
    }
  | { kind: 'image'; mimeType: string; dataChars: number }
  | { kind: 'unsupported'; blockType: string; keys: string[]; note: string };

export interface InternedMessage {
  role: string;
  /** Null means structure was not captured, rather than that no non-text parts existed. */
  blocks: InternedBlock[] | null;
  /** The flattened text-only view, which every generation carries. */
  textRef: BlobRef;
  toolCallId: string | null;
  toolName: string | null;
  isError: boolean | null;
  truncated: boolean;
  /** A block was described rather than carried (image data, unknown type, deep argument). */
  omitted: boolean;
  chars: number;
  redacted: boolean;
}

export interface InternedToolCall {
  id: string;
  name: string;
  argumentsRef: BlobRef;
  truncatedArguments: string[];
  redacted: boolean;
  depthCapped: boolean;
}

export interface CapturedCallInput {
  wallClockIso: string;
  messages: InternedMessage[];
  /** Number of messages in the captured input. */
  messageCount: number;
}

export interface CapturedCallOutput {
  wallClockIso: string;
  turnIndex: number;
  textRef: BlobRef;
  reasoningRef: BlobRef | null;
  reasoningRedacted: boolean;
  textCapture: { truncated: boolean; chars: number; redacted: boolean } | null;
  reasoningCapture: { truncated: boolean; chars: number; redacted: boolean } | null;
  stopReason: string;
  /** The provider's own error text, when the turn ended in one. Null when it did not. */
  providerErrorMessage: string | null;
  toolCalls: InternedToolCall[];
  usage: Record<string, number> | null;
}

/** One model call: what went in, what came back. Either half may be missing. */
export interface CapturedCall {
  decisionIndex: number;
  input: CapturedCallInput | null;
  output: CapturedCallOutput | null;
}

export interface CapturedToolDefinition {
  name: string;
  description: string;
  /** Pretty-printed JSON schema, interned. Null when the runtime advertised none. */
  parametersRef: BlobRef | null;
}

export interface CapturedHeader {
  redacted: boolean;
  provider: string;
  model: string;
  thinkingLevel: string;
  systemPromptRef: BlobRef;
  /**
   * Where `systemPromptRef` came from. `runtime_session` is the effective prompt read off
   * the live session; `harness_configured` is the text the harness asked for, which the
   * runtime then appends to. Null on a v1 header, which recorded neither.
   */
  systemPromptSource: 'runtime_session' | 'harness_configured' | null;
  harnessSystemPromptRef: BlobRef | null;
  initialUserPromptRef: BlobRef | null;
  toolDefinitions: CapturedToolDefinition[];
  settings: Record<string, unknown>;
}

/** The harness's own closing statement about how complete the capture is. */
export interface CapturedAudit {
  headerWritten: boolean;
  inputCount: number;
  outputCount: number;
  traceDecisionCount: number;
  decisionsMissingInput: number[];
  decisionsMissingOutput: number[];
  failureCount: number;
  truncatedMessageCount: number;
  redactedMessageCount: number;
  omittedBlockMessageCount: number;
  complete: boolean;
  note: string;
}

export type ContextFidelityLevel = 'none' | 'unreadable' | 'partial' | 'full';

export interface ContextFidelity {
  level: ContextFidelityLevel;
  /** The record schema version the sidecar was written at, when it was legible. */
  sourceVersion: number | null;
  /** Missing, altered or inconsistent evidence, including deliberate capture limits. */
  limitations: string[];
}

export interface ContextBundle {
  fidelity: ContextFidelity;
  header: CapturedHeader | null;
  /** Sorted by `decisionIndex`. */
  calls: CapturedCall[];
  audit: CapturedAudit | null;
}

export const NO_CONTEXT: ContextBundle = {
  fidelity: {
    level: 'none',
    sourceVersion: null,
    limitations: [
      'This run has no context.jsonl. Model-call context is unavailable; it may predate ' +
        'capture, have capture disabled, or be missing its sidecar. The trace records ' +
        'harness injections only.',
    ],
  },
  header: null,
  calls: [],
  audit: null,
};

export function callAt(
  bundle: ContextBundle,
  decisionIndex: number,
): CapturedCall | undefined {
  return bundle.calls.find((call) => call.decisionIndex === decisionIndex);
}

/** True when there is something worth showing for this decision. */
export function hasCapture(bundle: ContextBundle, decisionIndex: number): boolean {
  const call = callAt(bundle, decisionIndex);
  return call !== undefined && (call.input !== null || call.output !== null);
}

/** A short badge for the fidelity level, for places with no room for the full list. */
export function fidelityLabel(fidelity: ContextFidelity): string {
  switch (fidelity.level) {
    case 'full':
      return 'captured · no gaps detected';
    case 'partial':
      return 'partial capture';
    case 'unreadable':
      return 'capture unreadable';
    case 'none':
      return 'not captured';
  }
}
