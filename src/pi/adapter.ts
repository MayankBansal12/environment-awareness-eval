import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  VERSION,
  type AgentSession,
  type InlineExtension,
  type ToolExecutionEndEvent,
} from '@earendil-works/pi-coding-agent';

import type { RunConfig, ThinkingLevelName } from '../config/run-config.js';
import type { ExperimentEngine } from '../engine/experiment.js';
import { buildInitialUserPrompt, buildSystemPrompt } from '../prompt/system-prompt.js';
import { guardToolCall, type GuardOptions } from '../tools/path-guard.js';
import {
  createSlackTools,
  type PostSlackResult,
  type ReadSlackResult,
} from '../tools/slack-tools.js';
import { redactSecrets } from '../trace/writer.js';

export interface PiRunOptions {
  workspacePath: string;
  provider: string;
  model: string;
  thinkingLevel: ThinkingLevelName;
  timeoutMs: number;
  ticketDelivery: RunConfig['ticketDelivery'];
  engine: ExperimentEngine;
  guard: GuardOptions;
  onSessionReady?: (steer: (text: string) => Promise<void>) => void;
}

export interface PiRunResult {
  termination:
    | 'agent_finished'
    | 'max_turns'
    | 'max_actions'
    | 'timeout'
    | 'harness_error'
    | 'aborted';
  detail: string;
  finalAssistantText: string;
  piVersion: string;
  activeTools: string[];
  resourceIsolation: Record<string, boolean>;
}

interface ToolEnd {
  result: unknown;
  isError: boolean;
}

interface SlackEffect {
  read?: ReadSlackResult;
  post?: PostSlackResult;
}

function textFromContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || value === null) return '';
  const content = (value as { content?: unknown }).content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part !== 'object' || part === null) return '';
      const text = (part as { text?: unknown }).text;
      return typeof text === 'string' ? text : '';
    })
    .filter(Boolean)
    .join('\n');
}

export interface AssistantInfo {
  text: string;
  /** Joined `thinking` blocks, or undefined when the provider returned none. */
  reasoning: string | undefined;
  /** True when a thinking block came back redacted, carrying only a signature. */
  reasoningRedacted: boolean;
  /** `usage.reasoning`, when the provider reports a reasoning token breakdown. */
  reasoningTokens: number | undefined;
  stopReason: string;
  calls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
}

/**
 * Reads one Pi `AssistantMessage`.
 *
 * `content` is `(TextContent | ThinkingContent | ToolCall)[]`. Thinking blocks are read
 * alongside text and tool calls rather than dropped: what the model reasoned before acting
 * is the most direct evidence there is about whether it noticed an environment change, and
 * it is recoverable only here — nothing downstream can reconstruct it.
 *
 * Whether anything comes back is the provider's decision, not the harness's. A redacted
 * block carries an encrypted signature and no plaintext, and some providers return a
 * summary or nothing at all; `reasoning` stays undefined in those cases so that an absent
 * capture is never mistaken for a model that reasoned about nothing. `usage.reasoning` is
 * read separately for exactly that reason — providers that withhold the text often still
 * report the token count.
 */
export function assistantInfo(message: unknown): AssistantInfo {
  const empty: AssistantInfo = {
    text: '',
    reasoning: undefined,
    reasoningRedacted: false,
    reasoningTokens: undefined,
    stopReason: 'unknown',
    calls: [],
  };
  if (typeof message !== 'object' || message === null) return empty;

  const record = message as {
    content?: unknown;
    stopReason?: unknown;
    usage?: unknown;
  };
  const blocks = Array.isArray(record.content) ? record.content : [];
  const calls: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
  const text: string[] = [];
  const reasoning: string[] = [];
  let reasoningRedacted = false;

  for (const block of blocks) {
    if (typeof block !== 'object' || block === null) continue;
    const part = block as {
      type?: unknown;
      text?: unknown;
      thinking?: unknown;
      redacted?: unknown;
      id?: unknown;
      name?: unknown;
      arguments?: unknown;
    };
    if (part.type === 'text' && typeof part.text === 'string') text.push(part.text);
    if (part.type === 'thinking') {
      if (part.redacted === true) reasoningRedacted = true;
      if (typeof part.thinking === 'string' && part.thinking !== '') {
        reasoning.push(part.thinking);
      }
    }
    if (
      part.type === 'toolCall' &&
      typeof part.id === 'string' &&
      typeof part.name === 'string'
    ) {
      calls.push({
        id: part.id,
        name: part.name,
        input:
          typeof part.arguments === 'object' && part.arguments !== null
            ? (part.arguments as Record<string, unknown>)
            : {},
      });
    }
  }

  const usage =
    typeof record.usage === 'object' && record.usage !== null
      ? (record.usage as { reasoning?: unknown })
      : undefined;
  const reasoningTokens =
    typeof usage?.reasoning === 'number' && Number.isFinite(usage.reasoning)
      ? usage.reasoning
      : undefined;

  return {
    text: text.join('\n'),
    // A redacted-only turn still reasoned; it is recorded as present but empty so the
    // distinction from "no thinking blocks at all" survives into the trace.
    reasoning:
      reasoning.length > 0 ? reasoning.join('\n') : reasoningRedacted ? '' : undefined,
    reasoningRedacted,
    reasoningTokens,
    stopReason: typeof record.stopReason === 'string' ? record.stopReason : 'unknown',
    calls,
  };
}

export interface PiRunWithSlackOptions extends PiRunOptions {
  slack: Parameters<typeof createSlackTools>[0]['state'];
}

export async function runPiAgentWithSlack(
  options: PiRunWithSlackOptions,
): Promise<PiRunResult> {
  const ends = new Map<string, ToolEnd>();
  const slackEffects = new Map<string, SlackEffect>();
  const blocked = new Map<string, string>();
  let session: AgentSession | undefined;
  let forced: { reason: PiRunResult['termination']; detail: string } | undefined;
  let finalAssistantText = '';

  const customTools = createSlackTools({
    state: options.slack,
    logicalTime: () => options.engine.decisionIndex,
    onRead: (result, toolCallId) => {
      slackEffects.set(toolCallId, { read: result });
    },
    onPost: (result, toolCallId) => {
      slackEffects.set(toolCallId, { post: result });
    },
  });

  const ownedExtension: InlineExtension = {
    name: 'environment-awareness-observer',
    factory: (pi) => {
      pi.on('context', (event) => ({
        messages: options.engine.decisionBoundary(
          event.messages as unknown as Parameters<ExperimentEngine['decisionBoundary']>[0],
        ) as unknown as typeof event.messages,
      }));

      pi.on('tool_call', (event) => {
        const decision = guardToolCall(
          event.toolName,
          event.input as Record<string, unknown>,
          options.guard,
        );
        if (!decision.block) return undefined;
        blocked.set(event.toolCallId, decision.reason ?? 'blocked by harness');
        return { block: true, reason: decision.reason ?? 'blocked by harness' };
      });

      pi.on('tool_execution_end', (event) => {
        const end = event as ToolExecutionEndEvent;
        ends.set(end.toolCallId, { result: end.result, isError: end.isError });
      });

      pi.on('turn_end', async (event) => {
        const info = assistantInfo(event.message);
        finalAssistantText = info.text;
        for (const [siblingOrdinal, call] of info.calls.entries()) {
          const end = ends.get(call.id);
          const outputText = redactSecrets(textFromContent(end?.result));
          const actionIndex = options.engine.observeTool({
            toolCallId: call.id,
            toolName: call.name,
            batchId: 'turn-' + event.turnIndex,
            siblingOrdinal,
            input: call.input,
            outputText,
            isError: end?.isError ?? true,
            blockedByHarness: blocked.has(call.id),
            ...(blocked.has(call.id)
              ? { blockReason: blocked.get(call.id) ?? 'blocked' }
              : {}),
          });
          const effect = slackEffects.get(call.id);
          if (effect?.read !== undefined) {
            options.engine.observeSlackRead(
              actionIndex,
              effect.read.messages.map((message) => message.id),
              effect.read.readCursorAfter,
            );
          }
          if (effect?.post !== undefined) {
            options.engine.observeSlackPost(
              actionIndex,
              effect.post.messageId,
              effect.post.text,
            );
          }
        }

        const stop = await options.engine.settleTurn({
          turnIndex: event.turnIndex,
          assistantText: info.text,
          ...(info.reasoning === undefined ? {} : { reasoningText: info.reasoning }),
          ...(info.reasoningRedacted ? { reasoningRedacted: true } : {}),
          ...(info.reasoningTokens === undefined
            ? {}
            : { reasoningTokens: info.reasoningTokens }),
          stopReason: info.stopReason,
          toolCallNames: info.calls.map((call) => call.name),
        });
        if (stop !== undefined) {
          forced = { reason: stop.reason, detail: stop.detail };
          await session?.abort();
        }
      });
    },
  };

  // In-memory settings: the run must not inherit the host user's compaction, retry,
  // steering, tool-default or model preferences from ~/.pi/agent/settings.json.
  const settingsManager = SettingsManager.inMemory({
    // Compaction would rewrite the very context whose exposure we are measuring.
    compaction: { enabled: false },
    // One retry absorbs a transient provider error without silently re-running the agent.
    retry: { enabled: true, maxRetries: 1 },
    // Deliver one steering message per boundary, matching the protocol's one-event rule.
    steeringMode: 'one-at-a-time',
    followUpMode: 'one-at-a-time',
  });

  const loader = new DefaultResourceLoader({
    cwd: options.workspacePath,
    agentDir: getAgentDir(),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: buildSystemPrompt(options.ticketDelivery),
    appendSystemPrompt: [],
    extensionFactories: [ownedExtension],
  });
  await loader.reload();

  const modelRuntime = await ModelRuntime.create();
  const model = modelRuntime.getModel(options.provider, options.model);
  if (model === undefined) {
    throw new Error(
      `Pi model not found: ${options.provider}/${options.model}. Check "pi --list-models".`,
    );
  }
  const auth = await modelRuntime.checkAuth(options.provider);
  if (auth === undefined) {
    throw new Error(`Pi provider ${options.provider} is not authenticated.`);
  }

  const activeTools = [
    'read',
    'grep',
    'find',
    'ls',
    'edit',
    'write',
    'bash',
    'read_slack_messages',
    'post_slack_message',
  ];
  const created = await createAgentSession({
    cwd: options.workspacePath,
    modelRuntime,
    model,
    thinkingLevel: options.thinkingLevel,
    tools: activeTools,
    customTools,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(options.workspacePath),
    settingsManager,
  });
  session = created.session;
  options.onSessionReady?.((text) => session!.steer(text));

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        forced = {
          reason: 'timeout',
          detail: `exceeded configured timeout of ${options.timeoutMs}ms`,
        };
        void session?.abort();
        reject(new Error('eval run timed out'));
      }, options.timeoutMs);
    });
    await Promise.race([
      session.prompt(buildInitialUserPrompt(options.ticketDelivery)),
      timeout,
    ]);
  } catch (error) {
    if (forced === undefined) {
      forced = {
        reason: 'harness_error',
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    session.dispose();
  }

  return {
    termination: forced?.reason ?? 'agent_finished',
    detail: forced?.detail ?? 'agent completed the focal task',
    finalAssistantText,
    piVersion: VERSION,
    activeTools,
    resourceIsolation: {
      extensionsDisabledExceptOwned: true,
      skillsDisabled: true,
      promptTemplatesDisabled: true,
      contextFilesDisabled: true,
      themesDisabled: true,
      inMemorySession: true,
      inMemorySettings: true,
      compactionDisabled: true,
    },
  };
}
