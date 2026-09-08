/**
 * The captured model context, as the viewer holds it.
 *
 * `context.jsonl` is the harness's sidecar: per decision, the exact message array handed
 * to the runtime and the exact assistant output that came back. The loader ignored it
 * entirely until now, so the cockpit could say *that* a decision happened and what the
 * harness injected into it, but never what the model was actually looking at.
 *
 * Two things shape everything here.
 *
 * **Interning.** Context is quadratic: a 33-decision run carries its whole history 33
 * times, and `annotateMessages` re-renders the status block at a new anchor on every call,
 * so a naive inline copy is tens of megabytes for a handful of runs on top of a bundle
 * that is already ~5 MB. Every body is therefore content-addressed into one shared table
 * and referenced by id. Identical content gets an identical id by construction — the id is
 * assigned by a content-keyed map, not by hashing — so there is no collision to reason
 * about. In practice each message has two distinct forms across a run (with and without
 * the appended status block), which is exactly what interning is good at.
 *
 * **Fidelity.** The corpus spans generations. Fifty-six existing runs have no sidecar at
 * all, and a future one may have a partial or older sidecar. None of those are errors, and
 * none of them may be presented as if the data were merely empty — so every bundle carries
 * an explicit fidelity level and a list of what it cannot tell you.
 */

/** An id into `ViewerData.blobs`. Assigned by content, so equal text shares an id. */
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
  /**
   * Null for a v1 record, which captured no structure. Null means **not captured**, never
   * "this message had no non-text parts" — a v1 assistant turn that issued four tool calls
   * and a v1 assistant turn that only spoke are indistinguishable in the artifact.
   */
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
  /** As recorded, for cross-checking against `decision_boundary.contextMessageCount`. */
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

/** The versions of `context.jsonl` the viewer reads. Mirrors the harness's own list. */
export const SUPPORTED_CONTEXT_VERSIONS = [1, 2] as const;

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
