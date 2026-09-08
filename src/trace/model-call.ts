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
 * viewer interns bodies by hash at build time, which is safe precisely because it keys on
 * content rather than on position.
 *
 * ## What this is not
 *
 * It is the context as the harness handed it to the runtime, not the serialized provider
 * request. Sampling parameters, the provider's own wire format and any preamble the
 * runtime adds below this seam are not visible here. The field is named
 * `capturedModelContext` rather than `request` for that reason: claiming to hold the
 * provider payload when it holds the message array would be the artifact lying about its
 * own fidelity.
 */

import { z } from 'zod';

export const MODEL_CALL_SCHEMA_VERSION = 1;

/** Per-message cap. Generous: a truncated context defeats the point of capturing it. */
export const MAX_MESSAGE_TEXT = 24_000;

/** Per-tool-call-argument cap, applied per argument value. */
export const MAX_ARGUMENT_TEXT = 24_000;

const capturedMessageSchema = z.object({
  /** `user`, `assistant`, `toolResult`, … as the runtime labelled it. */
  role: z.string(),
  /** Flattened text of the message. Non-text parts are described, never dropped silently. */
  text: z.string(),
  /** Present on tool results; this is what `statusAnchor` refers to. */
  toolCallId: z.string().optional(),
  /** True when `text` hit `MAX_MESSAGE_TEXT` and was cut. */
  truncated: z.boolean(),
  /** Length before truncation, in UTF-16 code units. */
  chars: z.number().int().nonnegative(),
});

export type CapturedMessage = z.infer<typeof capturedMessageSchema>;

const toolDefinitionSchema = z.object({
  name: z.string(),
  description: z.string(),
  /** The JSON schema the runtime advertised for this tool, when it exposed one. */
  parameters: z.unknown().optional(),
});

export const modelCallRecordSchema = z.discriminatedUnion('type', [
  /**
   * Run-level constants, written once. The system prompt and tool definitions do not vary
   * per call, so repeating them 30 times would be pure noise.
   */
  z.object({
    schemaVersion: z.literal(MODEL_CALL_SCHEMA_VERSION),
    type: z.literal('capture_header'),
    runId: z.string(),
    provider: z.string(),
    model: z.string(),
    thinkingLevel: z.string(),
    systemPrompt: z.string(),
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
    reasoningText: z.string().optional(),
    reasoningRedacted: z.boolean().optional(),
    stopReason: z.string(),
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
        /** Argument keys whose values hit `MAX_ARGUMENT_TEXT`. */
        truncatedArguments: z.array(z.string()),
      }),
    ),
    /** Token usage as the provider reported it, when it reported any. */
    usage: z.record(z.string(), z.number()).optional(),
  }),
]);

export type ModelCallRecord = z.infer<typeof modelCallRecordSchema>;

export type ModelCallRecordInput =
  | Omit<Extract<ModelCallRecord, { type: 'capture_header' }>, 'schemaVersion'>
  | Omit<Extract<ModelCallRecord, { type: 'call_input' }>, 'schemaVersion'>
  | Omit<Extract<ModelCallRecord, { type: 'call_output' }>, 'schemaVersion'>;

/** Bounds one message body, reporting what it cost rather than cutting silently. */
export function captureText(
  value: string,
  limit: number = MAX_MESSAGE_TEXT,
): { text: string; truncated: boolean; chars: number } {
  if (value.length <= limit) {
    return { text: value, truncated: false, chars: value.length };
  }
  return { text: value.slice(0, limit), truncated: true, chars: value.length };
}
