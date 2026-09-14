/**
 * Captured model context: the literal messages each model call received and returned,
 * recorded beside the trace at the Pi runtime seam (not the provider wire payload).
 */
import { z } from 'zod';
import { isSensitiveKey, redactSecrets } from './redact.js';

/** Per-message cap. Generous: a truncated context defeats the point of capturing it. */
export const MAX_MESSAGE_TEXT = 24_000;

/** Per-tool-call-argument cap, applied per string value including nested ones. */
export const MAX_ARGUMENT_TEXT = 24_000;

/** How deep the capture walks a tool argument before describing the rest. */
export const MAX_ARGUMENT_DEPTH = 12;

/* -------------------------------------------------------------------------- */
/* Message blocks                                                              */
/* -------------------------------------------------------------------------- */

/**
 * One part of one message, preserved by kind rather than flattened to text.
 *
 * Pi message content is `(TextContent | ThinkingContent | ToolCall)[]` on an assistant
 * message and `(TextContent | ImageContent)[]` on a tool result. Unrecognised kinds are described rather than dropped, so a runtime that
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
