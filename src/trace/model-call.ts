/**
 * The captured model context: what each model call actually received and returned.
 *
 * `trace.jsonl` records the experiment — what was exposed, what the agent did, how it was
 * graded. It deliberately keeps only metadata about tool calls, because it is read whole by
 * the grader and by every test. This file records the other thing a reader needs: the
 * literal input and output of each call to the model.
 *
 * ## Why a sidecar rather than more trace events
 *
 * Context is quadratic. Every decision carries the whole conversation so far, so a
 * 33-decision run repeats its own history 33 times; measured against the existing corpus
 * that is ~24 MB where the traces are ~4 MB. Folding that into `trace.jsonl` would make the
 * primary artifact ten times larger for every consumer that does not need it, so it lives
 * in `context.jsonl` beside it, keyed by `decisionIndex`.
 *
 * ## Why full snapshots rather than deltas
 *
 * A delta encoding looks obvious and is wrong here. `annotateMessages` calls `cloneClean`
 * on every call, which strips the previously injected `<environment_status>` and
 * `<environment_event>` blocks from *all* messages and re-appends the status block at the
 * current anchor. A message captured at one decision therefore does not have the same
 * content at the next, so "what was appended since last time" cannot reconstruct the array.
 * Each record holds the complete message list. Deduplication is a reader's problem — the
 * viewer content-addresses bodies by hash at build time, which is safe precisely because it
 * keys on content rather than on position.
 *
 * ## What this is not
 *
 * It is the context as the harness handed it to the runtime, not the serialized provider
 * request. Sampling parameters, the provider's own wire format and any preamble the
 * runtime adds below this seam are not visible here. The field is named
 * `capturedModelContext` rather than `request` for that reason: claiming to hold the
 * provider payload when it holds the message array would be the artifact lying about its
 * own fidelity.
 *
 * ## Schema history
 *
 * - **v1** — text-only messages. `capturedMessage.text` was the `'\n'`-join of the text
 *   parts and every other part of a message was dropped without a trace, so a v1 record
 *   cannot distinguish an assistant turn that only spoke from one that also thought and
 *   issued four tool calls. No redaction was applied on this path, and the header was
 *   written only after the run completed, so an interrupted run had none at all.
 * - **v2** — structured `blocks` per message (text, thinking, tool call, image,
 *   unrecognised), explicit per-message `truncated` / `redacted` flags, the effective
 *   runtime system prompt with its provenance, and a closing `capture_audit` record that
 *   states how complete the capture actually is. `text` is retained as the flattened
 *   text-only view so a v1 reader keeps working.
 */

import { z } from 'zod';
import { isSensitiveKey, redactSecrets } from './redact.js';

export const MODEL_CALL_SCHEMA_VERSION = 2;

/**
 * The generations a reader is expected to accept. The harness only ever writes the
 * current one; this exists so the viewer and the tests name the same set.
 */
export const SUPPORTED_MODEL_CALL_SCHEMA_VERSIONS = [1, 2] as const;
export type SupportedModelCallSchemaVersion =
  (typeof SUPPORTED_MODEL_CALL_SCHEMA_VERSIONS)[number];

/** Per-message cap. Generous: a truncated context defeats the point of capturing it. */
export const MAX_MESSAGE_TEXT = 24_000;

/** Per-tool-call-argument cap, applied per string value including nested ones. */
export const MAX_ARGUMENT_TEXT = 24_000;

/** Cap on the failure list carried in `capture_audit`. The count stays exact. */
export const MAX_RECORDED_FAILURES = 20;

/** How deep the capture walks a tool argument before describing the rest. */
export const MAX_ARGUMENT_DEPTH = 12;

/* -------------------------------------------------------------------------- */
/* Message blocks                                                              */
/* -------------------------------------------------------------------------- */

/**
 * One part of one message, preserved by kind rather than flattened to text.
 *
 * Pi message content is `(TextContent | ThinkingContent | ToolCall)[]` on an assistant
 * message and `(TextContent | ImageContent)[]` on a tool result. v1 kept only the text
 * parts, which silently deleted the tool calls that are the whole record of what the model
 * decided to do. Unrecognised kinds are described rather than dropped, so a runtime that
 * adds a block type shows up in the artifact as an unknown block instead of as nothing.
 */
export const capturedBlockSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('text'),
    text: z.string(),
    truncated: z.boolean(),
    /** Length after redaction and before truncation, in UTF-16 code units. */
    chars: z.number().int().nonnegative(),
    /** True when secret redaction rewrote part of this block. */
    redacted: z.boolean(),
  }),
  z.object({
    kind: z.literal('thinking'),
    /** Empty when the provider returned a safety-redacted block carrying no plaintext. */
    text: z.string(),
    /**
     * True when the *provider* redacted the thinking. Distinct from `redacted`, which
     * reports the harness's own secret scrub — conflating them would make a provider
     * safety filter indistinguishable from a token in the model's reasoning.
     */
    providerRedacted: z.boolean(),
    truncated: z.boolean(),
    chars: z.number().int().nonnegative(),
    redacted: z.boolean(),
  }),
  z.object({
    kind: z.literal('toolCall'),
    id: z.string(),
    name: z.string(),
    arguments: z.record(z.string(), z.unknown()),
    /** Top-level argument keys with at least one value that hit `MAX_ARGUMENT_TEXT`. */
    truncatedArguments: z.array(z.string()),
    redacted: z.boolean(),
    /**
     * True when an argument nested deeper than the capture walks was replaced by a note.
     * Separate from `truncatedArguments`, which is about length: this is about reach.
     */
    depthCapped: z.boolean(),
  }),
  z.object({
    kind: z.literal('image'),
    mimeType: z.string(),
    /**
     * Size of the base64 payload. The payload itself is deliberately not carried: it is
     * megabytes of no diagnostic value, and dropping it silently is what v1 did.
     */
    dataChars: z.number().int().nonnegative(),
    /** Always true. Stated rather than implied, so no reader has to infer it. */
    payloadOmitted: z.literal(true),
  }),
  z.object({
    kind: z.literal('unsupported'),
    /** The `type` the runtime labelled it with, or `'unknown'` if it carried none. */
    blockType: z.string(),
    /** The keys the block carried, so an unrecognised shape is still identifiable. */
    keys: z.array(z.string()),
    note: z.string(),
    /** Always true: the block's payload is described by its keys, not carried. */
    payloadOmitted: z.literal(true),
  }),
]);

export type CapturedBlock = z.infer<typeof capturedBlockSchema>;

export const capturedMessageSchema = z.object({
  /** `user`, `assistant`, `toolResult`, … as the runtime labelled it. */
  role: z.string(),
  /**
   * Every part of the message, in order. v1 records have no `blocks`; a reader must treat
   * its absence as "not captured", never as "the message had no non-text parts".
   */
  blocks: z.array(capturedBlockSchema).optional(),
  /**
   * Flattened text of the message: the `'\n'`-join of its text blocks. Retained from v1
   * so existing readers keep working, and useful for search. It is a *view*, not the
   * record — `blocks` is the record.
   */
  text: z.string(),
  /** Present on tool results; this is what `statusAnchor` refers to. */
  toolCallId: z.string().optional(),
  /** Present on tool results, when the runtime labelled them. */
  toolName: z.string().optional(),
  /** Present on tool results, when the runtime labelled them. */
  isError: z.boolean().optional(),
  /** True when text in this message was cut at a length cap. */
  truncated: z.boolean(),
  /**
   * True when at least one block's payload is *described* rather than carried: image data,
   * an unrecognised block type, or a tool argument past the nesting cap.
   *
   * Deliberately distinct from `truncated`. A truncated message is one the capture holds a
   * prefix of; an omitted one is a message the capture never held at all in that part.
   * Collapsing them would let a reader treat a described image as complete text.
   */
  omitted: z.boolean().optional(),
  /** Total text length after redaction and before truncation, in UTF-16 code units. */
  chars: z.number().int().nonnegative(),
  /** True when secret redaction rewrote part of this message. */
  redacted: z.boolean().optional(),
});

export type CapturedMessage = z.infer<typeof capturedMessageSchema>;

const toolDefinitionSchema = z.object({
  name: z.string(),
  description: z.string(),
  /** The JSON schema the runtime advertised for this tool, when it exposed one. */
  parameters: z.unknown().optional(),
});

/**
 * Where the recorded system prompt came from.
 *
 * `runtime_session` is the effective prompt read back off the live session, which is what
 * the model was actually sent — the runtime appends its own lines (`Current working
 * directory:`) below the configured prompt. `harness_configured` is the fallback for when
 * that getter is unavailable, and says so rather than passing the configured text off as
 * the effective one.
 */
export const systemPromptSourceSchema = z.enum(['runtime_session', 'harness_configured']);
export type SystemPromptSource = z.infer<typeof systemPromptSourceSchema>;

export const captureFailureSchema = z.object({
  stage: z.enum(['capture_header', 'call_input', 'call_output', 'capture_audit']),
  /** Null for run-level records that belong to no single decision. */
  decisionIndex: z.number().int().nullable(),
  message: z.string(),
});

export type CaptureFailure = z.infer<typeof captureFailureSchema>;

export const captureTextMetadataSchema = z.object({
  truncated: z.boolean(),
  chars: z.number().int().nonnegative(),
  redacted: z.boolean(),
});
export type CaptureTextMetadata = z.infer<typeof captureTextMetadataSchema>;

export const modelCallRecordSchema = z.discriminatedUnion('type', [
  /**
   * Run-level constants, written once, as soon as the session exists. The system prompt
   * and tool definitions do not vary per call, so repeating them 30 times would be pure
   * noise — but writing them only at the end meant a run that timed out or lost its
   * provider left a sidecar whose calls could not be interpreted at all.
   */
  z.object({
    schemaVersion: z.literal(MODEL_CALL_SCHEMA_VERSION),
    type: z.literal('capture_header'),
    runId: z.string(),
    provider: z.string(),
    model: z.string(),
    thinkingLevel: z.string(),
    /** The effective prompt; see `systemPromptSource` for what that means here. */
    systemPrompt: z.string(),
    systemPromptSource: systemPromptSourceSchema,
    redacted: z.boolean().optional(),
    /** What the harness configured, always, so the runtime's additions are visible. */
    harnessSystemPrompt: z.string(),
    /** The first user message, which is where the ticket lands under direct delivery. */
    initialUserPrompt: z.string(),
    /** Names plus whatever schema the runtime advertised. Absent when it exposed none. */
    toolDefinitions: z.array(toolDefinitionSchema),
    /** Settings the harness pinned that change what the model sees or how it is sampled. */
    settings: z.record(z.string(), z.unknown()),
  }),

  /** The input to one model call, captured at its decision boundary. */
  z.object({
    schemaVersion: z.literal(MODEL_CALL_SCHEMA_VERSION),
    type: z.literal('call_input'),
    decisionIndex: z.number().int(),
    wallClockIso: z.string(),
    /**
     * Every message handed to the runtime for this call, in order, after the harness's own
     * annotation. This is the context the model saw.
     */
    capturedModelContext: z.array(capturedMessageSchema),
    /** Cross-check against `decision_boundary.contextMessageCount` in the trace. */
    messageCount: z.number().int().nonnegative(),
  }),

  /** The output of one model call, captured when its turn settles. */
  z.object({
    schemaVersion: z.literal(MODEL_CALL_SCHEMA_VERSION),
    type: z.literal('call_output'),
    decisionIndex: z.number().int(),
    turnIndex: z.number().int(),
    wallClockIso: z.string(),
    text: z.string(),
    textCapture: captureTextMetadataSchema.optional(),
    reasoningCapture: captureTextMetadataSchema.optional(),
    reasoningText: z.string().optional(),
    reasoningRedacted: z.boolean().optional(),
    stopReason: z.string(),
    /**
     * The provider's own error text, when the turn ended in one.
     *
     * Pi puts it on `AssistantMessage.errorMessage` and nothing else persists it: the
     * trace records only `stopReason: 'error'` and the run's termination reason, which say
     * that the provider failed but not why. On a free or rate-limited endpoint that
     * distinction is the whole diagnosis, and a pilot cannot report an external blocker
     * honestly without it.
     */
    providerErrorMessage: z.string().optional(),
    /**
     * Tool calls with their **full** arguments, unlike `tool_action.inputSummary`, which
     * keeps only paths and commands and reduces a `write` to a byte count. The largest
     * thing a model emits is usually a file body; recording only its length makes the
     * output side of the call unreadable.
     */
    toolCalls: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        arguments: z.record(z.string(), z.unknown()),
        /** Top-level argument keys with a value that hit `MAX_ARGUMENT_TEXT`. */
        truncatedArguments: z.array(z.string()),
        redacted: z.boolean().optional(),
        depthCapped: z.boolean().optional(),
      }),
    ),
    /** Token usage as the provider reported it, when it reported any. */
    usage: z.record(z.string(), z.number()).optional(),
  }),

  /**
   * The closing statement of what was and was not captured.
   *
   * A capture failure must never change a behavioural grade — the run either produced a
   * gradeable trace or it did not, and whether its context serialized is a property of the
   * diagnostics, not of the agent. So failures are counted here instead of thrown, and a
   * reader can tell an honestly incomplete sidecar from a complete one without diffing it
   * against the trace by hand.
   */
  z.object({
    schemaVersion: z.literal(MODEL_CALL_SCHEMA_VERSION),
    type: z.literal('capture_audit'),
    runId: z.string(),
    /** False when the run died before its session existed. */
    headerWritten: z.boolean(),
    inputCount: z.number().int().nonnegative(),
    outputCount: z.number().int().nonnegative(),
    /** Decisions the trace recorded a `decision_boundary` for. */
    traceDecisionCount: z.number().int().nonnegative(),
    /** Captured an output but no input — a boundary whose input serialization failed. */
    decisionsMissingInput: z.array(z.number().int()),
    /**
     * Captured an input but no output. The last decision of an aborted, timed-out or
     * provider-failed run is expected to appear here: the model was asked and never
     * answered. That is a fact about the run, not a defect in the capture.
     */
    decisionsMissingOutput: z.array(z.number().int()),
    failures: z.array(captureFailureSchema),
    /** Exact, even when `failures` was capped at `MAX_RECORDED_FAILURES`. */
    failureCount: z.number().int().nonnegative(),
    /** Messages whose text was cut at `MAX_MESSAGE_TEXT`. */
    truncatedMessageCount: z.number().int().nonnegative(),
    /** Messages where secret redaction rewrote something. */
    redactedMessageCount: z.number().int().nonnegative(),
    /** Messages carrying at least one described-not-carried block. */
    omittedBlockMessageCount: z.number().int().nonnegative(),
    /** True only when the header is present, nothing failed, and no input is missing. */
    complete: z.boolean(),
    note: z.string(),
  }),
]);

export type ModelCallRecord = z.infer<typeof modelCallRecordSchema>;

type WithoutVersion<T> = Omit<T, 'schemaVersion'>;

export type ModelCallRecordInput =
  | WithoutVersion<Extract<ModelCallRecord, { type: 'capture_header' }>>
  | WithoutVersion<Extract<ModelCallRecord, { type: 'call_input' }>>
  | WithoutVersion<Extract<ModelCallRecord, { type: 'call_output' }>>
  | WithoutVersion<Extract<ModelCallRecord, { type: 'capture_audit' }>>;

/* -------------------------------------------------------------------------- */
/* Capture helpers                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Bounds one body, reporting what it cost rather than cutting silently.
 *
 * Redaction runs *before* the measurement, so a secret cannot survive by straddling the
 * truncation boundary, and `chars` therefore reports the post-redaction length. In
 * practice the two differ only for text that contained a secret at all.
 */
export function captureText(
  value: string,
  limit: number = MAX_MESSAGE_TEXT,
): { text: string; truncated: boolean; chars: number; redacted: boolean } {
  const scrubbed = redactSecrets(value);
  const redacted = scrubbed !== value;
  if (scrubbed.length <= limit) {
    return { text: scrubbed, truncated: false, chars: scrubbed.length, redacted };
  }
  return {
    text: scrubbed.slice(0, limit),
    truncated: true,
    chars: scrubbed.length,
    redacted,
  };
}

/** The structural shape of a runtime message part, as the capture path sees it. */
export interface CaptureBlockSource {
  type: string;
  [key: string]: unknown;
}

/** The structural shape of a runtime message, as the capture path sees it. */
export interface CaptureMessageSource {
  role: string;
  content: string | CaptureBlockSource[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

/**
 * Redacts and bounds every string reachable inside a tool-call argument value.
 *
 * v1 walked only the top level, so a secret or a 2 MB file body nested one object deep
 * went through untouched. Non-string leaves pass through unchanged: they are structural
 * (edit ranges, flags, counts) and rewriting them would change their type.
 */
function captureArgumentValue(
  value: unknown,
  state: { truncated: boolean; redacted: boolean; depthCapped: boolean },
  key: string | null,
  depth = 0,
): unknown {
  // A guard, not a policy: tool arguments are JSON and shallow. Anything this deep is a
  // pathological or cyclic structure, and describing it beats hanging on it. Flagged so
  // the record does not pass off a note as the value it replaced.
  if (depth > MAX_ARGUMENT_DEPTH) {
    state.depthCapped = true;
    return `[capture: nesting deeper than ${MAX_ARGUMENT_DEPTH} levels was not walked]`;
  }
  if (typeof value === 'string') {
    // The key decides first. A value under `password` is a credential whatever it looks
    // like, and no pattern over the string would ever catch it.
    if (key !== null && isSensitiveKey(key)) {
      state.redacted = true;
      return '[REDACTED]';
    }
    const captured = captureText(value, MAX_ARGUMENT_TEXT);
    if (captured.truncated) state.truncated = true;
    if (captured.redacted) state.redacted = true;
    return captured.text;
  }
  if (Array.isArray(value)) {
    // Array entries inherit the key of the array itself: `{"tokens": ["a", "b"]}` is as
    // sensitive as `{"token": "a"}`.
    return value.map((entry) => captureArgumentValue(entry, state, key, depth + 1));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([entryKey, entry]) => [
        entryKey,
        captureArgumentValue(entry, state, entryKey, depth + 1),
      ]),
    );
  }
  return value;
}

export interface CapturedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  truncatedArguments: string[];
  redacted: boolean;
  depthCapped: boolean;
}

/** Bounds and scrubs one tool call's arguments, naming the top-level keys it had to cut. */
export function captureToolCall(call: {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}): CapturedToolCall {
  const bounded: Record<string, unknown> = {};
  const truncatedArguments: string[] = [];
  let redacted = false;
  let depthCapped = false;
  for (const [key, value] of Object.entries(call.arguments)) {
    const state = { truncated: false, redacted: false, depthCapped: false };
    bounded[key] = captureArgumentValue(value, state, key);
    if (state.truncated) truncatedArguments.push(key);
    if (state.redacted) redacted = true;
    if (state.depthCapped) depthCapped = true;
  }
  return {
    id: call.id,
    name: call.name,
    arguments: bounded,
    truncatedArguments,
    redacted,
    depthCapped,
  };
}

/** Maps one runtime message part onto a captured block, describing what it cannot keep. */
export function captureBlock(part: CaptureBlockSource): CapturedBlock {
  const type = typeof part.type === 'string' ? part.type : 'unknown';

  if (type === 'text' && typeof part['text'] === 'string') {
    const captured = captureText(part['text']);
    return {
      kind: 'text',
      text: captured.text,
      truncated: captured.truncated,
      chars: captured.chars,
      redacted: captured.redacted,
    };
  }

  if (type === 'thinking') {
    const raw = typeof part['thinking'] === 'string' ? part['thinking'] : '';
    const captured = captureText(raw);
    return {
      kind: 'thinking',
      text: captured.text,
      providerRedacted: part['redacted'] === true,
      truncated: captured.truncated,
      chars: captured.chars,
      redacted: captured.redacted,
    };
  }

  if (
    type === 'toolCall' &&
    typeof part['id'] === 'string' &&
    typeof part['name'] === 'string'
  ) {
    const args =
      typeof part['arguments'] === 'object' && part['arguments'] !== null
        ? (part['arguments'] as Record<string, unknown>)
        : {};
    const captured = captureToolCall({
      id: part['id'],
      name: part['name'],
      arguments: args,
    });
    return {
      kind: 'toolCall',
      id: captured.id,
      name: captured.name,
      arguments: captured.arguments,
      truncatedArguments: captured.truncatedArguments,
      redacted: captured.redacted,
      depthCapped: captured.depthCapped,
    };
  }

  if (type === 'image') {
    return {
      kind: 'image',
      mimeType: typeof part['mimeType'] === 'string' ? part['mimeType'] : 'unknown',
      dataChars: typeof part['data'] === 'string' ? part['data'].length : 0,
      payloadOmitted: true,
    };
  }

  return {
    kind: 'unsupported',
    blockType: type,
    keys: Object.keys(part).sort(),
    note:
      `block type ${JSON.stringify(type)} is not one this capture understands; ` +
      'its keys are recorded so the shape stays identifiable',
    payloadOmitted: true,
  };
}

/**
 * Flattens one runtime message into the captured form.
 *
 * A string `content` becomes a single text block, so `blocks` is always the complete
 * record regardless of which shape the runtime used.
 */
export function captureMessage(message: CaptureMessageSource): CapturedMessage {
  const parts: CaptureBlockSource[] =
    typeof message.content === 'string'
      ? [{ type: 'text', text: message.content }]
      : message.content;

  const blocks = parts.map(captureBlock);

  let truncated = false;
  let redacted = false;
  let omitted = false;
  let chars = 0;
  const textParts: string[] = [];
  for (const block of blocks) {
    if (block.kind === 'text') {
      textParts.push(block.text);
      chars += block.chars;
      if (block.truncated) truncated = true;
      if (block.redacted) redacted = true;
    } else if (block.kind === 'thinking') {
      chars += block.chars;
      if (block.truncated) truncated = true;
      if (block.redacted) redacted = true;
    } else if (block.kind === 'toolCall') {
      if (block.truncatedArguments.length > 0) truncated = true;
      if (block.redacted) redacted = true;
      // A depth-capped argument is a payload the capture never walked, not a long one it
      // shortened, so it counts as an omission rather than as truncation.
      if (block.depthCapped) omitted = true;
    } else {
      // `image` and `unsupported`: described, not carried.
      omitted = true;
    }
  }

  return {
    role: message.role,
    blocks,
    // The v1 field, preserved exactly: the '\n'-join of the text parts and nothing else.
    text: textParts.join('\n'),
    ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId }),
    ...(message.toolName === undefined ? {} : { toolName: message.toolName }),
    ...(message.isError === undefined ? {} : { isError: message.isError }),
    truncated,
    omitted,
    chars,
    redacted,
  };
}
