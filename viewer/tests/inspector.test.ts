/**
 * The model-call inspector must never present a gap as data.
 *
 * The corpus spans runs with a full capture, runs with none at all, and runs whose
 * provider quit mid-turn and left an input with no output. Each of those has to read
 * differently on screen — that is the whole point of the fidelity labels — so these tests
 * pin the distinctions rather than the prose around them.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ModelCallInspector } from '../src/ui/ModelCallInspector.js';
import {
  NO_CONTEXT,
  type ContextBundle,
  type InternedMessage,
} from '../src/derive/context.js';
import type { RunBundle } from '../src/derive/model.js';

const BLOBS: Record<string, string> = {
  input: 'original input',
  reply: 'assistant reply',
  args: '{"command":"test"}',
  result: 'later tool result',
  reason: 'provider reasoning',
};

function message(textRef: string, role = 'user'): InternedMessage {
  return {
    role,
    textRef,
    blocks: [{ kind: 'text', ref: textRef, truncated: false, chars: 10, redacted: false }],
    toolCallId: null,
    toolName: null,
    isError: null,
    truncated: false,
    redacted: false,
    omitted: false,
    chars: 10,
  };
}

function runWith(context: ContextBundle): RunBundle {
  return { runId: 'r', context, trace: [] } as unknown as RunBundle;
}

function render(context: ContextBundle, decisionIndex = 0): string {
  return renderToStaticMarkup(
    createElement(ModelCallInspector, {
      run: runWith(context),
      decisionIndex,
      blobs: BLOBS,
    }),
  );
}

/**
 * Two decisions: D0 issues a `bash` call and answers, D1 carries that call's result in its
 * input and has no output of its own — the shape a run that lost its provider leaves.
 */
const captured: ContextBundle = {
  ...NO_CONTEXT,
  fidelity: { level: 'full', sourceVersion: 2, limitations: [] },
  calls: [
    {
      decisionIndex: 0,
      input: { wallClockIso: '', messageCount: 1, messages: [message('input')] },
      output: {
        wallClockIso: '',
        turnIndex: 0,
        textRef: 'reply',
        textCapture: { truncated: false, chars: 15, redacted: false },
        reasoningCapture: { truncated: false, chars: 18, redacted: false },
        reasoningRef: 'reason',
        reasoningRedacted: false,
        stopReason: 'toolUse',
        providerErrorMessage: null,
        toolCalls: [
          {
            id: 't1',
            name: 'bash',
            argumentsRef: 'args',
            truncatedArguments: [],
            redacted: false,
            depthCapped: false,
          },
        ],
        usage: { input: 50, output: 10 },
      },
    },
    {
      decisionIndex: 1,
      input: {
        wallClockIso: '',
        messageCount: 2,
        messages: [
          message('input'),
          { ...message('result', 'toolResult'), toolCallId: 't1', toolName: 'bash' },
        ],
      },
      output: null,
    },
  ],
};

describe('model call inspector', () => {
  it('does not show a later tool result as part of the selected decision input', () => {
    // The result of a call issued at D0 only enters the conversation at D1. Rendering it
    // inside D0's input would show the model something it had not yet been given, which
    // is precisely the confusion this eval exists to measure.
    const html = render(captured);
    const inputColumn = html
      .split('aria-label="Input to selected decision"')[1]!
      .split('aria-label="Output of selected decision"')[0]!;

    expect(inputColumn).toContain('original input');
    expect(inputColumn).not.toContain('later tool result');

    // It is still reachable, paired with the call it answers and labelled with where it
    // was actually read from.
    expect(html).toContain('later tool result');
    expect(html).toContain('captured input of D1');
    expect(html).toContain('assistant reply');
    expect(html).toContain('provider reasoning');
  });

  it('labels a run with no capture as a partial reconstruction, not as empty', () => {
    const html = render(NO_CONTEXT);
    expect(html).toContain('Partial reconstruction');
    expect(html).toContain('were not captured');
    expect(html).toContain('not captured');
    expect(html).not.toContain('full capture');
  });

  it('distinguishes a missing output from an empty assistant response', () => {
    expect(render(captured, 1)).toContain('matching output is missing');
    expect(render(captured, 0)).not.toContain('matching output is missing');
  });

  it('marks output truncation and secret redaction separately', () => {
    const modified = structuredClone(captured);
    modified.calls[0]!.output!.textCapture = {
      truncated: true,
      redacted: true,
      chars: 25_000,
    };
    const html = render(modified);
    expect(html).toContain('truncated');
    expect(html).toContain('secret redacted');
  });

  it('says a provider error happened rather than showing an empty response', () => {
    const modified = structuredClone(captured);
    modified.calls[0]!.output!.providerErrorMessage = 'upstream 429: rate limited';
    const html = render(modified);
    expect(html).toContain('The provider returned an error');
    expect(html).toContain('upstream 429: rate limited');
  });

  it('never implies the model did no reasoning when none was captured', () => {
    const modified = structuredClone(captured);
    modified.calls[0]!.output!.reasoningRef = null;
    const html = render(modified);
    expect(html).toContain('not evidence that the model did no reasoning');
  });
});
