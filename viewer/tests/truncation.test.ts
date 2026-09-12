/**
 * Truncation reporting must match what the writer actually did.
 *
 * The viewer previously tested `outputBytes` against `MAX_TRACE_TEXT` (4000) when the
 * writer caps `outputPreview` at `MAX_TOOL_OUTPUT_PREVIEW` (1500) characters, so it
 * under-reported truncation by an order of magnitude. These tests pin both the unit
 * (characters, not bytes) and the cap against the corpus on disk, so a future change to
 * either fails here rather than silently mislabelling every log row.
 */

import { describe, expect, it } from 'vitest';
import {
  boundText,
  MAX_TOOL_OUTPUT_PREVIEW,
  MAX_TRACE_TEXT,
} from '../../src/trace/schema.js';
import { data } from '../src/data.js';
import { truncationOf } from '../src/derive/truncation.js';

describe('truncation detection', () => {
  it('reports nothing for output that fit under the cap', () => {
    const result = truncationOf('a short line of output');
    expect(result.truncated).toBe(false);
    expect(result.omittedChars).toBeNull();
  });

  it('detects truncation and recovers the original length', () => {
    const original = 'x'.repeat(MAX_TOOL_OUTPUT_PREVIEW + 643);
    const result = truncationOf(boundText(original, MAX_TOOL_OUTPUT_PREVIEW));
    expect(result.truncated).toBe(true);
    expect(result.omittedChars).toBe(643);
    expect(result.originalChars).toBe(original.length);
  });

  it('does not treat output at exactly the cap as truncated', () => {
    const exact = 'x'.repeat(MAX_TOOL_OUTPUT_PREVIEW);
    expect(truncationOf(boundText(exact, MAX_TOOL_OUTPUT_PREVIEW)).truncated).toBe(false);
  });

  it('counts characters, not bytes', () => {
    // 1400 astral-plane characters: 2 UTF-16 units each, 4 bytes each. Under the
    // character cap, far over it in bytes — the old byte comparison called this truncated.
    const emoji = '😀'.repeat(700);
    expect(emoji.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_PREVIEW);
    expect(Buffer.byteLength(emoji, 'utf8')).toBeGreaterThan(MAX_TOOL_OUTPUT_PREVIEW);
    expect(truncationOf(boundText(emoji, MAX_TOOL_OUTPUT_PREVIEW)).truncated).toBe(false);
  });
});

describe.skipIf(data.runs.length === 0)('the optional historical corpus on disk', () => {
  const actions = data.runs.flatMap((run) =>
    run.trace.filter(
      (event): event is Extract<typeof event, { type: 'tool_action' }> =>
        event.type === 'tool_action',
    ),
  );

  it('has tool actions to check', () => {
    expect(actions.length).toBeGreaterThan(0);
  });

  it('never carries a preview longer than the cap plus its own note', () => {
    for (const action of actions) {
      const result = truncationOf(action.outputPreview);
      if (result.truncated) {
        expect(result.omittedChars).not.toBeNull();
        expect(result.originalChars).toBeGreaterThan(MAX_TOOL_OUTPUT_PREVIEW);
      } else {
        expect(action.outputPreview.length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_PREVIEW);
      }
    }
  });
});

// This regression must run even when saved inference results have been archived.
it('detects output truncated below the old MAX_TRACE_TEXT threshold', () => {
  const original = 'x'.repeat(MAX_TOOL_OUTPUT_PREVIEW + 500);
  expect(Buffer.byteLength(original)).toBeLessThan(MAX_TRACE_TEXT);
  expect(truncationOf(boundText(original, MAX_TOOL_OUTPUT_PREVIEW)).truncated).toBe(true);
});
