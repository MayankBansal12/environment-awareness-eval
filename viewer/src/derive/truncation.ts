/**
 * Whether a recorded tool output was truncated, and by how much.
 *
 * The writer caps `outputPreview` with `boundText(text, MAX_TOOL_OUTPUT_PREVIEW)` — 1500
 * UTF-16 code units, not the 4000 of `MAX_TRACE_TEXT`, and not bytes. Two mistakes follow
 * from ignoring that, and the viewer made both: testing `outputBytes > MAX_TRACE_TEXT`
 * misses every output between the real cap and 4000, and testing `outputBytes >
 * outputPreview.length` compares `Buffer.byteLength` against `String.length`, which
 * disagree for any non-ASCII output.
 *
 * The reliable test is the one the writer itself implies: it appends a note when and only
 * when it truncated, so a preview longer than the cap is exactly a truncated preview. The
 * note also carries the omitted count, which recovers the original length — better than a
 * bare "truncated" flag, and free.
 *
 * A future trace generation should record this explicitly rather than leaving it to be
 * parsed back out of a human-readable suffix.
 */

import {
  MAX_TOOL_OUTPUT_PREVIEW,
  TRUNCATION_NOTE,
} from '../../../src/trace/schema.js';

export interface Truncation {
  truncated: boolean;
  /** Characters the writer dropped, read back from its own note. Null if unparseable. */
  omittedChars: number | null;
  /** Length of the output before truncation, when the omitted count could be read. */
  originalChars: number | null;
}

const NOTE = new RegExp(`\\n… \\[(\\d+)${TRUNCATION_NOTE.replace(/[[\]]/g, '\\$&')}$`);

/**
 * Prefers what a v5 trace recorded, falling back to reading the writer's note.
 *
 * v5 records `outputTruncated` and `outputChars` directly. Older traces do not, so the
 * note the writer appended is the only evidence; it is reliable, but parsing prose is not
 * something a reader should keep doing once the fact is recorded properly.
 */
export function truncationOfAction(action: {
  outputPreview: string;
  outputTruncated?: boolean | undefined;
  outputChars?: number | undefined;
}): Truncation {
  if (action.outputTruncated !== undefined) {
    const chars = action.outputChars ?? null;
    return {
      truncated: action.outputTruncated,
      omittedChars:
        action.outputTruncated && chars !== null ? chars - MAX_TOOL_OUTPUT_PREVIEW : null,
      originalChars: action.outputTruncated ? chars : null,
    };
  }
  return truncationOf(action.outputPreview);
}

export function truncationOf(outputPreview: string): Truncation {
  if (outputPreview.length <= MAX_TOOL_OUTPUT_PREVIEW) {
    return { truncated: false, omittedChars: null, originalChars: null };
  }
  const match = NOTE.exec(outputPreview);
  const omitted = match?.[1] === undefined ? null : Number.parseInt(match[1], 10);
  return {
    truncated: true,
    omittedChars: omitted,
    originalChars: omitted === null ? null : MAX_TOOL_OUTPUT_PREVIEW + omitted,
  };
}

/** e.g. `capped at 1500 chars by the trace writer · 2143 omitted`. */
export function describeTruncation(truncation: Truncation): string {
  if (!truncation.truncated) return '';
  const base = `capped at ${MAX_TOOL_OUTPUT_PREVIEW} chars by the trace writer`;
  return truncation.omittedChars === null
    ? base
    : `${base} · ${truncation.omittedChars} omitted`;
}
