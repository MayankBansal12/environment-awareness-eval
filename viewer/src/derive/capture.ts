import type { CapturedMessage } from '../../../src/harness/capture.js';
import type { RunBundle } from './model.js';
import type { ContextBundle, InternedMessage, InternedBlock } from './context.js';
export function capturedContext(run: RunBundle) {
  const blobs: Record<string, string> = {};
  const ids = new Map<string, string>();
  const intern = (text: string) => {
    if (!ids.has(text)) {
      const id = String(ids.size);
      ids.set(text, id);
      blobs[id] = text;
    }
    return ids.get(text)!;
  };
  const message = (m: CapturedMessage): InternedMessage => ({
    ...m,
    omitted: m.omitted ?? false,
    redacted: m.redacted ?? false,
    textRef: intern(m.text),
    toolCallId: m.toolCallId ?? null,
    toolName: m.toolName ?? null,
    isError: m.isError ?? null,
    blocks:
      m.blocks?.map((b): InternedBlock =>
        b.kind === 'text' || b.kind === 'thinking'
          ? { ...b, ref: intern(b.text) }
          : b.kind === 'toolCall'
            ? { ...b, argumentsRef: intern(JSON.stringify(b.arguments, null, 2)) }
            : b,
      ) ?? null,
  });
  const messages = run.messages.map(message);
  const decisions = run.trace.filter((e) => e.type === 'input').map((e) => e.decision);
  const missingInput = decisions.filter((d) => !run.inputs[d]);
  const missingOutput = decisions.filter((d) => !run.outputs[d]);
  const limitations: string[] = [];
  if (!run.header) limitations.push('No context header was captured.');
  if (missingInput.length) limitations.push(`Missing inputs: ${missingInput.join(', ')}.`);
  if (missingOutput.length)
    limitations.push(`Missing outputs: ${missingOutput.join(', ')}.`);
  if (!run.capture) limitations.push('No closing capture audit was recorded.');
  if (run.capture && (!run.capture.complete || run.capture.partialContent))
    limitations.push(run.capture.note || 'The capture audit reports partial content.');
  const all = [...run.messages, ...Object.values(run.outputs)];
  if (all.some((m) => m.truncated || m.redacted || m.omitted || !m.blocks))
    limitations.push(
      'Some captured messages are truncated, redacted, omitted, or text-only.',
    );
  const bundle: ContextBundle = {
    fidelity: {
      level: !run.header && !all.length ? 'none' : limitations.length ? 'partial' : 'full',
      sourceVersion: null,
      limitations,
    },
    header: run.header
      ? {
          redacted: false,
          provider: String(run.header.runtime['provider'] ?? 'unknown'),
          model: String(run.header.runtime['model'] ?? 'unknown'),
          thinkingLevel: String(run.header.runtime['thinking'] ?? 'unspecified'),
          systemPromptRef: intern(run.header.systemPrompt),
          systemPromptSource: 'runtime_session',
          harnessSystemPromptRef: null,
          initialUserPromptRef:
            typeof run.header.runtime['initialPrompt'] === 'string'
              ? intern(run.header.runtime['initialPrompt'])
              : null,
          toolDefinitions: run.header.tools.map((t) => ({
            name: t.name,
            description: t.description,
            parametersRef: intern(JSON.stringify(t.parameters, null, 2) ?? 'null'),
          })),
          settings: run.header.runtime,
        }
      : null,
    calls: decisions.map((d) => {
      const input = run.trace.find((e) => e.type === 'input' && e.decision === d);
      const output = run.trace.find((e) => e.type === 'output' && e.decision === d);
      const m = run.outputs[d];
      const thinking = m?.blocks?.filter((b) => b.kind === 'thinking') ?? [];
      return {
        decisionIndex: d,
        input: run.inputs[d]
          ? {
              wallClockIso: input?.at ?? '',
              messages: run.inputs[d]!.map((i) => messages[i]!),
              messageCount: run.inputs[d]!.length,
            }
          : null,
        output: m
          ? {
              wallClockIso: output?.at ?? '',
              turnIndex: d,
              textRef: intern(m.text),
              reasoningRef: thinking.length
                ? intern(thinking.map((b) => b.text).join('\n'))
                : null,
              reasoningRedacted: thinking.some((b) => b.providerRedacted),
              textCapture: {
                truncated: m.truncated,
                chars: m.chars,
                redacted: m.redacted ?? false,
              },
              reasoningCapture: thinking.length
                ? {
                    truncated: thinking.some((b) => b.truncated),
                    chars: thinking.reduce((n, b) => n + b.chars, 0),
                    redacted: thinking.some((b) => b.redacted),
                  }
                : null,
              stopReason: output?.type === 'output' ? output.stopReason : 'not recorded',
              providerErrorMessage:
                output?.type === 'output' ? (output.errorMessage ?? null) : null,
              toolCalls:
                m.blocks
                  ?.filter((b) => b.kind === 'toolCall')
                  .map((b) => ({
                    ...b,
                    argumentsRef: intern(JSON.stringify(b.arguments, null, 2)),
                  })) ?? [],
              usage:
                output?.type === 'output' && output.usage
                  ? Object.fromEntries(
                      Object.entries(output.usage).filter(
                        (e): e is [string, number] => typeof e[1] === 'number',
                      ),
                    )
                  : null,
            }
          : null,
      };
    }),
    audit: null,
  };
  return { bundle, blobs };
}
