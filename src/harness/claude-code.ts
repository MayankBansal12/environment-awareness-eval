import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  createSdkMcpServer,
  query,
  tool,
  type HookCallback,
  type SDKAssistantMessage,
  type SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { Engine } from '../engine.js';
import type { Budgets } from '../runner.js';
import { definitions } from '../tools.js';
import type { UsageMeter } from '../usage.js';
import type { ModelSelection } from './model.js';
import type { ControlledTools } from './repo-tools.js';

const exec = promisify(execFile);
const PREFIX = 'mcp__workspace__';
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
export const CLAUDE_CONTEXT_NOTE =
  'Claude Code hook context and assistant outputs; excludes its internal prompt/history and compaction summaries. Full SDK events are in claude-code.jsonl.';

export async function verifyClaudeCode(selection: ModelSelection) {
  const { stdout } = await exec('claude', ['--version'], { timeout: 15_000 });
  const auth = await exec('claude', ['auth', 'status'], { timeout: 15_000 });
  if (!JSON.parse(auth.stdout).loggedIn) throw Error('Log in with claude auth login');
  return {
    agent: 'claude-code',
    agentVersion: stdout.trim(),
    ...selection,
    requested: { ...selection },
    api: 'claude-code-agent-sdk',
    authSource: 'claude-code',
    fallbackPolicy: 'claude-code-default',
    maxOutputTokens: 8192,
    outputBudgetTransport: 'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
    contextCapture: 'claude-code-hooks',
    usageSource: 'claude-code-modelUsage',
    callCountsScope: 'visible-main-loop',
    costBreakdownAvailable: false,
    retriesManagedBy: 'claude-code',
  };
}

/** Normalize Claude's output to the small message shape used by the eval engine. */
export function claudeMessage(message: SDKAssistantMessage['message']) {
  const u = message.usage;
  return {
    role: 'assistant',
    model: message.model,
    content: message.content.map((block) => {
      if (block.type === 'tool_use')
        return {
          type: 'toolCall',
          id: block.id,
          name: block.name.replace(PREFIX, ''),
          arguments: block.input,
        };
      return block;
    }),
    stopReason:
      message.stop_reason === 'tool_use'
        ? 'toolUse'
        : message.stop_reason === 'max_tokens'
          ? 'length'
          : 'stop',
    usage: {
      input: u.input_tokens,
      output: u.output_tokens,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
      totalTokens:
        u.input_tokens +
        u.output_tokens +
        (u.cache_read_input_tokens ?? 0) +
        (u.cache_creation_input_tokens ?? 0),
    },
  };
}

/** The result's per-model totals include internal calls such as compaction. */
export function applyClaudeUsage(meter: UsageMeter, result: SDKResultMessage) {
  const models = Object.values(result.modelUsage);
  if (!models.length) return;
  const sum = (
    key:
      | 'inputTokens'
      | 'outputTokens'
      | 'cacheReadInputTokens'
      | 'cacheCreationInputTokens'
      | 'thinkingTokens',
  ) => models.reduce((total, model) => total + (model[key] ?? 0), 0);
  Object.assign(meter.totals, {
    input: sum('inputTokens'),
    output: sum('outputTokens'),
    cacheRead: sum('cacheReadInputTokens'),
    cacheWrite: sum('cacheCreationInputTokens'),
    reasoning: sum('thinkingTokens'),
    totalTokens:
      sum('inputTokens') +
      sum('outputTokens') +
      sum('cacheReadInputTokens') +
      sum('cacheCreationInputTokens'),
  });
  meter.totals.costUsd.total = result.total_cost_usd;
}

// Tool parameters are flat objects in the controlled tool set. Sorting avoids
// depending on the order in which MCP's schema parser returns their keys.
const callKey = (name: string, args: Record<string, unknown>) =>
  JSON.stringify([name, Object.entries(args).sort(([a], [b]) => a.localeCompare(b))]);

export async function runClaudeCode(options: {
  selection: ModelSelection;
  cwd: string;
  systemPrompt: string;
  initialPrompt: string;
  tools: ControlledTools;
  engine: Engine;
  meter: UsageMeter;
  budgets: Budgets;
  abortController: AbortController;
  afterTurn: (message: unknown) => Promise<void>;
  stop: (reason: string, detail: string) => void;
  persist: (event: unknown) => void;
}) {
  const { engine, meter, abortController } = options;
  const pending = new Map<string, string[]>();
  const defs = definitions(options.tools);
  const server = createSdkMcpServer({
    name: 'workspace',
    alwaysLoad: true,
    tools: defs.map((d) =>
      tool(
        d.name,
        d.description,
        (z.fromJSONSchema(JSON.parse(JSON.stringify(d.parameters))) as z.ZodObject).shape,
        async (args) => {
          const id = pending.get(callKey(PREFIX + d.name, args))?.shift();
          if (!id) throw Error('Missing Claude Code tool-use ID');
          const observation = await options.tools.run(
            id,
            d.name,
            args,
            abortController.signal,
          );
          return {
            content: [{ type: 'text', text: JSON.stringify(observation.value) }],
            isError: observation.isError,
          };
        },
      ),
    ),
  });
  let current: SDKAssistantMessage['message'] | undefined;
  let ready = deferred<SDKAssistantMessage['message']>();
  let completed = false;
  let result: SDKResultMessage | undefined;
  // After a guard stop (budget, timeout, harness error) the SDK can still stream further model
  // turns before the abort propagates. Those are runtime artifacts, not decisions under the
  // protocol: exactly one such turn has been recorded at the stop's decision, so any additional
  // assistant message would break input/output decision pairing. Track the stop and completion.
  let stopped = false;
  let recorded = false;
  const stop = (...args: Parameters<typeof options.stop>) => {
    stopped = true;
    options.stop(...args);
  };
  const hookContext = () => {
    const [message] = engine.beforeDecision([{ role: 'user', content: '' }]);
    return message!.content;
  };
  const guarded =
    (hook: HookCallback): HookCallback =>
    async (...args) => {
      try {
        return await hook(...args);
      } catch (error) {
        stop('harness_error', String(error));
        return { continue: false, stopReason: String(error) };
      }
    };
  const finish = async (message: SDKAssistantMessage['message'], error?: string) => {
    if (stopped && recorded) return;
    const normalized = {
      ...claudeMessage(message),
      ...(error ? { stopReason: 'error', errorMessage: error } : {}),
      ...(abortController.signal.aborted ? { stopReason: 'aborted' } : {}),
    };
    meter.add(normalized, 'turn');
    if (meter.totals.totalTokens > options.budgets.maxTotalTokens)
      stop('token_budget', 'Run token budget reached');
    if (abortController.signal.aborted) normalized.stopReason = 'aborted';
    await options.afterTurn(normalized);
    recorded = true;
    completed = true;
  };
  const run = query({
    prompt: options.initialPrompt,
    options: {
      pathToClaudeCodeExecutable: 'claude',
      cwd: options.cwd,
      model: options.selection.model,
      systemPrompt: options.systemPrompt,
      tools: [],
      allowedTools: defs.map((d) => PREFIX + d.name),
      permissionMode: 'dontAsk',
      mcpServers: { workspace: server },
      strictMcpConfig: true,
      settingSources: [],
      settings: {
        autoMemoryEnabled: false,
        autoCompactEnabled: options.budgets.compaction,
      },
      persistSession: false,
      includePartialMessages: true,
      extraArgs: { 'disable-slash-commands': null },
      env: {
        ...process.env,
        CLAUDECODE: undefined,
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8192',
        ENABLE_TOOL_SEARCH: 'false',
      },
      abortController,
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              guarded(async () => ({
                hookSpecificOutput: {
                  hookEventName: 'UserPromptSubmit',
                  additionalContext: hookContext(),
                },
              })),
            ],
          },
        ],
        PreToolUse: [
          {
            hooks: [
              guarded(async (input) => {
                if (input.hook_event_name !== 'PreToolUse') return {};
                if (!defs.some((d) => PREFIX + d.name === input.tool_name))
                  throw Error('Unexpected Claude Code tool: ' + input.tool_name);
                const key = callKey(
                  input.tool_name,
                  input.tool_input as Record<string, unknown>,
                );
                const ids = pending.get(key) ?? [];
                ids.push(input.tool_use_id);
                pending.set(key, ids);
                return {};
              }),
            ],
          },
        ],
        PostToolBatch: [
          {
            hooks: [
              guarded(async () => {
                await finish(await ready.promise);
                if (abortController.signal.aborted) return { continue: false };
                ready = deferred();
                completed = false;
                return {
                  hookSpecificOutput: {
                    hookEventName: 'PostToolBatch',
                    additionalContext: hookContext(),
                  },
                };
              }),
            ],
          },
        ],
        PreCompact: [
          {
            hooks: [
              async () => {
                engine.emit({ type: 'compaction', phase: 'start', reason: 'auto' });
                return {};
              },
            ],
          },
        ],
        PostCompact: [
          {
            hooks: [
              async () => {
                engine.emit({ type: 'compaction', phase: 'end', reason: 'auto' });
                return {};
              },
            ],
          },
        ],
      },
    },
  });
  try {
    for await (const event of run) {
      options.persist(event);
      if (stopped && recorded) break;
      if (event.type === 'stream_event' && !event.parent_tool_use_id) {
        const part = event.event;
        if (part.type === 'message_start') {
          current = structuredClone(part.message) as SDKAssistantMessage['message'];
          current.content = [];
          completed = false;
        } else if (part.type === 'message_delta' && current) {
          current.stop_reason = part.delta.stop_reason;
          Object.assign(current.usage, part.usage);
        } else if (part.type === 'message_stop' && current) {
          ready.resolve(current);
          if (!current.content.some((b) => b.type === 'tool_use')) await finish(current);
        }
      } else if (event.type === 'assistant' && !event.parent_tool_use_id) {
        if (event.error && !completed) {
          await finish(
            event.message,
            event.message.content
              .flatMap((b) => (b.type === 'text' ? [b.text] : []))
              .join('\n'),
          );
        } else if (current) current.content.push(...event.message.content);
      } else if (event.type === 'system' && event.subtype === 'api_retry') {
        engine.emit({
          type: 'provider_retry',
          attempt: event.attempt,
          maxAttempts: event.max_retries,
          delayMs: event.retry_delay_ms,
          errorMessage: event.error,
        });
      } else if (event.type === 'result') {
        result = event;
        applyClaudeUsage(meter, event);
        if (meter.totals.totalTokens > options.budgets.maxTotalTokens)
          options.stop('token_budget', 'Run token budget reached');
      }
    }
  } finally {
    abortController.abort();
    run.close();
    await run.return();
    await options.tools.idle();
  }
  if (!result && !stopped) throw Error('Claude Code exited without a result');
  if ((result?.is_error || result?.subtype !== 'success') && !stopped)
    return {
      reason: 'provider_error',
      detail:
        result?.subtype === 'success' ? result.result : (result?.errors ?? []).join('; '),
    };
  if (!completed && !stopped)
    throw Error('Claude Code ended without a complete assistant response');
  return { reason: 'agent_finished', detail: 'Claude Code ended its turn' };
}
