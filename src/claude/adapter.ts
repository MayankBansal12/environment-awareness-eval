/** Native Claude Code session; one MCP batch per assistant decision. */
import {
  spawn,
  execFileSync,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import {
  createCodingTools,
  createGrepTool,
  createFindTool,
  createLsTool,
} from '@earendil-works/pi-coding-agent';
import { z } from 'zod';
import { NativeTurnAssembler, BatchBarrier, SiblingCollector } from './protocol.js';
import type { PiRunWithSlackOptions, PiRunResult } from '../pi/adapter.js';
import { createSlackTools } from '../tools/slack-tools.js';
import { guardToolCall } from '../tools/path-guard.js';
import { buildInitialUserPrompt, buildSystemPrompt } from '../prompt/system-prompt.js';
import type { AnnotatableMessage } from '../engine/environment.js';
import { redactSecrets } from '../trace/writer.js';

export const batchSchema = z.object({
  actions: z
    .array(z.object({ name: z.string(), input: z.record(z.string(), z.unknown()) }))
    .min(1)
    .max(120),
});
export function parseBatch(input: unknown, names: string[], remaining: number) {
  const parsed = batchSchema.parse(input);
  if (parsed.actions.length > remaining)
    throw new Error('batch exceeds remaining action budget');
  for (const action of parsed.actions)
    if (!names.includes(action.name)) throw new Error(`unknown tool: ${action.name}`);
  return parsed.actions;
}
/**
 * A new native assistant message overlaps the previous one only while that message's tool
 * batch is still executing. Once it has settled, HTTP requests for its siblings that have
 * not yet arrived are served from the run-level result cache, so a lagging sibling must not
 * read as a second concurrent decision.
 */
export function nativeDecisionsOverlap(
  pending: { started?: boolean; settled?: boolean } | undefined,
  busy: boolean,
): boolean {
  return busy || (pending?.started === true && pending.settled !== true);
}
export function claudeArgs(
  model: string,
  effort: string,
  system: string,
  url: string,
): string[] {
  return [
    '-p',
    '--model',
    model,
    '--effort',
    effort,
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--tools',
    '',
    '--strict-mcp-config',
    '--mcp-config',
    JSON.stringify({ mcpServers: { eval: { type: 'http', url } } }),
    '--allowedTools',
    'mcp__eval__*',
    '--disable-slash-commands',
    '--setting-sources',
    '',
    '--settings',
    '{"disableAllHooks":true}',
    '--no-session-persistence',
    '--system-prompt',
    system,
  ];
}
export async function runClaudeAgentWithSlack(
  options: PiRunWithSlackOptions & { nativeLogPath: string; maxActions: number },
): Promise<PiRunResult> {
  const log = (record: unknown) =>
    appendFileSync(
      options.nativeLogPath,
      redactSecrets(JSON.stringify({ at: new Date().toISOString(), record })) + '\n',
    );
  const version = execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim();
  const effects = new Map<
    string,
    {
      read?: Parameters<NonNullable<Parameters<typeof createSlackTools>[0]['onRead']>>[0];
      post?: Parameters<Parameters<typeof createSlackTools>[0]['onPost']>[0];
    }
  >();
  const tools = [
    ...createCodingTools(options.workspacePath),
    createGrepTool(options.workspacePath),
    createFindTool(options.workspacePath),
    createLsTool(options.workspacePath),
    ...createSlackTools({
      state: options.slack,
      logicalTime: () => options.engine.decisionIndex,
      onRead: (read, id) => {
        effects.set(id, { read });
      },
      onPost: (post, id) => {
        effects.set(id, { post });
      },
    }),
  ];
  const names = tools.map((t) => t.name);
  const definitions = tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
  const system = buildSystemPrompt(options.ticketDelivery);
  let child: ChildProcessWithoutNullStreams | undefined;
  let forced: { reason: PiRunResult['termination']; detail: string } | undefined;
  let finalText = '';
  type ResponsePair = {
    resolve: (value: unknown) => void;
    reject: (error: unknown) => void;
  };
  let pending:
    | {
        text: string;
        reasoning?: string;
        collector: SiblingCollector<ResponsePair>;
        started?: boolean;
        settled?: boolean;
        outputs: Map<string, unknown>;
      }
    | undefined;
  let busy = false;
  const barrier = new BatchBarrier();
  // Keyed by native tool_use id (== `_meta["claudecode/toolUseId"]`), and kept for the
  // whole run so a call the CLI redelivers after an MCP reconnect is answered from cache
  // instead of executing its effect a second time.
  const servedResults = new Map<string, unknown>();
  // Extra resolvers waiting on a tool_use id whose batch is still running.
  const inflight = new Map<string, Array<(value: unknown) => void>>();
  let resultSeen = false;
  let streamBuffer = '';
  const assembler = new NativeTurnAssembler();
  let chain = Promise.resolve();
  const history: AnnotatableMessage[] = [];
  const abort = new AbortController();
  const fail = (detail: string, reason: PiRunResult['termination'] = 'harness_error') => {
    forced ??= { reason, detail };
    abort.abort();
    if (child?.pid) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        /* already exited */
      }
    }
  };
  const sendUser = (text: string) => {
    const record = { type: 'user', message: { role: 'user', content: text } };
    log({ stdin: record });
    child!.stdin.write(JSON.stringify(record) + '\n');
  };
  options.onSessionReady?.({
    steer: async (text) => {
      history.push({ role: 'user', content: text });
      sendUser(text);
    },
    toolDefinitions: definitions.map((d) => ({ ...d, name: 'mcp__eval__' + d.name })),
    effectiveSystemPrompt: undefined,
  });
  const route = '/' + randomUUID();
  const server = createServer(async (req, res) => {
    if (req.url !== route || req.method !== 'POST') {
      res.writeHead(404).end();
      return;
    }
    try {
      let body = '';
      for await (const chunk of req) {
        body += String(chunk);
        if (body.length > 2_000_000) throw new Error('MCP request too large');
      }
      log({ mcpRequest: JSON.parse(body) });
      const message = JSON.parse(body) as {
        id?: string | number;
        method: string;
        params?: { name?: string; arguments?: unknown };
      };
      if (message.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      let result: unknown;
      if (message.method === 'initialize')
        result = {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: 'environment-awareness-eval', version: '1' },
        };
      else if (message.method === 'tools/list')
        result = {
          tools: definitions.map((d) => ({
            name: d.name,
            description: d.description,
            inputSchema: d.parameters,
          })),
        };
      else if (message.method === 'ping') result = {};
      else if (message.method === 'tools/call') {
        // Claude dispatches MCP as soon as its tool block completes, before message_stop,
        // and may redeliver a call verbatim after an MCP reconnect. Identity is the native
        // tool_use id it carries in `_meta`, not the argument shape.
        const toolUseId = (message.params as { _meta?: Record<string, unknown> })?._meta?.[
          'claudecode/toolUseId'
        ] as string | undefined;
        if (toolUseId !== undefined && servedResults.has(toolUseId)) {
          result = servedResults.get(toolUseId);
        } else {
          // Hold execution until the WHOLE assistant message is known, including siblings.
          await chain;
          await barrier.wait(abort.signal);
          await chain;
          if (!pending || !names.includes(message.params?.name ?? ''))
            throw new Error('unsupported concurrent/missing assistant batch');
          const turn = pending;
          const response = new Promise<unknown>((resolve, reject) => {
            // Redelivery of a call this turn already answered, or one still running.
            if (toolUseId !== undefined && turn.outputs.has(toolUseId)) {
              resolve(turn.outputs.get(toolUseId));
              return;
            }
            if (
              toolUseId !== undefined &&
              (turn.collector.received.has(toolUseId) || inflight.has(toolUseId))
            ) {
              const list = inflight.get(toolUseId) ?? [];
              list.push(resolve);
              inflight.set(toolUseId, list);
              return;
            }
            if (toolUseId !== undefined) inflight.set(toolUseId, []);
            turn.collector.add(
              {
                actions: [{ name: message.params!.name, input: message.params!.arguments }],
              },
              { resolve, reject },
              toolUseId,
            );
            for (const [id, pair] of turn.collector.received)
              if (turn.outputs.has(id)) pair.resolve(turn.outputs.get(id));
            if (turn.started) return;
            turn.started = true;
            busy = true;
            void (async () => {
              // Validate the entire native sibling batch before the first effect.
              const groups = turn.collector.calls.map((call) => ({
                ...call,
                actions: parseBatch(
                  call.input,
                  names,
                  options.maxActions - options.engine.actionIndex,
                ),
              }));
              const total = groups.reduce((n, g) => n + g.actions.length, 0);
              if (total > options.maxActions - options.engine.actionIndex)
                throw new Error('native sibling batch exceeds remaining action budget');
              const calls = [];
              let ordinal = 0;
              history.push({ role: 'assistant', content: turn.text });
              for (const group of groups) {
                const outputs: unknown[] = [];
                for (const [localOrdinal, action] of group.actions.entries()) {
                  if (abort.signal.aborted) throw new Error('run aborted');
                  const id = group.id + ':' + localOrdinal;
                  const guard = guardToolCall(action.name, action.input, options.guard);
                  let output: unknown;
                  let isError = false;
                  try {
                    if (guard.block) throw new Error(guard.reason);
                    const tool = tools.find((t) => t.name === action.name)!;
                    output = await tool.execute(
                      id,
                      action.input as never,
                      abort.signal,
                      undefined,
                      undefined as never,
                    );
                  } catch (error) {
                    isError = true;
                    output = { content: [{ type: 'text', text: String(error) }] };
                  }
                  const text = JSON.stringify(output);
                  const index = options.engine.observeTool({
                    toolCallId: id,
                    toolName: action.name,
                    batchId: 'turn-' + options.engine.turnOrdinal,
                    siblingOrdinal: ordinal++,
                    input: action.input,
                    outputText: redactSecrets(text),
                    isError,
                    blockedByHarness: guard.block,
                    ...(guard.reason ? { blockReason: guard.reason } : {}),
                  });
                  const effect = effects.get(id);
                  if (effect?.read)
                    options.engine.observeSlackRead(
                      index,
                      effect.read.messages.map((m) => m.id),
                      effect.read.readCursorAfter,
                    );
                  if (effect?.post)
                    options.engine.observeSlackPost(
                      index,
                      effect.post.messageId,
                      effect.post.text,
                    );
                  outputs.push({ id, name: action.name, result: output, isError });
                  calls.push({ id, name: action.name, arguments: action.input });
                }
                history.push({
                  role: 'toolResult',
                  toolCallId: group.id,
                  content: JSON.stringify(outputs),
                });
              }
              const stop = await options.engine.settleTurn({
                assistantText: turn.text,
                ...(turn.reasoning ? { reasoningText: turn.reasoning } : {}),
                stopReason: 'toolUse',
                toolCallNames: calls.map((a) => a.name),
                toolCalls: calls,
              });
              if (stop) {
                fail(stop.detail, stop.reason);
                throw new Error(stop.detail);
              }
              const annotated = options.engine.decisionBoundary(history);
              // All sibling effects and the single snapshot precede EVERY response.
              for (const group of groups) {
                const observation = annotated.find(
                  (m) => m.toolCallId === group.id,
                )!.content;
                const result = {
                  content: [
                    {
                      type: 'text',
                      text:
                        typeof observation === 'string'
                          ? observation
                          : JSON.stringify(observation),
                    },
                  ],
                };
                log({
                  mcpResult: result,
                  toolUseId: group.id,
                  decision: options.engine.decisionIndex,
                });
                turn.outputs.set(group.id, result);
                servedResults.set(group.id, result);
                turn.collector.received.get(group.id)?.resolve(result);
                for (const extra of inflight.get(group.id) ?? []) extra(result);
                inflight.delete(group.id);
              }
              turn.settled = true;
              busy = false;
            })().catch((error) => {
              for (const pair of turn.collector.received.values()) pair.reject(error);
              fail(String(error));
            });
          });
          result = await response;
        }
      } else {
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32601, message: 'Method not found' },
          }),
        );
        return;
      }
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    } catch (error) {
      log({ bridgeError: String(error) });
      fail(String(error));
      res.writeHead(500).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing MCP port');
  const args = claudeArgs(
    options.model,
    options.thinkingLevel,
    system,
    `http://127.0.0.1:${address.port}${route}`,
  );
  log({
    runtime: 'claude-code',
    version,
    args,
    capture: 'native stream plus harness observations; not provider requests',
  });
  child = spawn('claude', args, {
    cwd: options.workspacePath,
    detached: true,
    stdio: 'pipe',
    env: {
      ...process.env,
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      DISABLE_AUTO_COMPACT: '1',
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '100',
    },
  });
  const timer = setTimeout(
    () =>
      fail(
        `active/wall budget ${options.timeoutMs}ms exceeded (no unbounded quota waits)`,
        'timeout',
      ),
    options.timeoutMs,
  );
  const heartbeat = setInterval(() => {
    log({
      heartbeat: true,
      decision: options.engine.decisionIndex,
      actions: options.engine.actionIndex,
    });
    process.stderr.write(
      `Claude alive D${options.engine.decisionIndex} A${options.engine.actionIndex}\n`,
    );
  }, 30_000);
  child.stderr.on('data', (chunk) => {
    log({ stderr: String(chunk) });
    process.stderr.write(redactSecrets(String(chunk)));
  });
  child.stdout.on('data', (chunk) => {
    streamBuffer += String(chunk);
    let newline: number;
    while ((newline = streamBuffer.indexOf('\n')) >= 0) {
      const line = streamBuffer.slice(0, newline);
      streamBuffer = streamBuffer.slice(newline + 1);
      if (!line.trim()) continue;
      chain = chain
        .then(async () => {
          const event = JSON.parse(line);
          log(event);
          if (event.type === 'system' && event.subtype === 'compact_boundary')
            throw new Error('unsupported native compaction');
          // Each assistant message re-arms the barrier: a tool block from this turn that the
          // CLI dispatches early must wait for THIS turn's message_stop, not sail through on
          // the previous turn's publish and bind to a spent collector.
          if (event.type === 'stream_event' && event.event?.type === 'message_start')
            barrier.reset();
          const nativeTurn = assembler.accept(event);
          if (nativeTurn) {
            const blocks = nativeTurn.blocks;
            const allCalls = blocks.filter((b) => b.type === 'tool_use');
            // The CLI streams a tool block whose JSON did not parse as `__unparsedToolInput`,
            // never dispatches it, feeds the model a synthetic error and lets it re-emit the
            // call. That recovery is the CLI's, not a model decision: drop the block and wait
            // for the retry rather than failing the run.
            const malformed = allCalls.filter(
              (c) =>
                c.input &&
                typeof c.input === 'object' &&
                '__unparsedToolInput' in (c.input as object),
            );
            const calls = allCalls.filter((c) => !malformed.includes(c));
            if (malformed.length)
              log({
                skippedMalformedToolInput: malformed.map((c) => ({
                  id: c.id,
                  name: c.name,
                })),
              });
            const text = blocks
              .filter((b) => b.type === 'text')
              .map((b) => b.text ?? '')
              .join('\n');
            const reasoning = blocks
              .filter((b) => b.type === 'thinking')
              .map((b) => b.thinking ?? '')
              .join('\n');
            if (!malformed.length) finalText = text;
            // Overlap = a batch still executing. A settled batch whose straggler HTTP
            // requests have not all arrived is normal: those are answered from servedResults.
            if (calls.length) {
              if (nativeDecisionsOverlap(pending, busy))
                throw new Error('overlapping native model decisions');
              pending = {
                text,
                ...(reasoning ? { reasoning } : {}),
                collector: new SiblingCollector(
                  calls.map((c) => ({
                    id: c.id!,
                    input: {
                      actions: [
                        { name: c.name!.replace('mcp__eval__', ''), input: c.input },
                      ],
                    },
                  })),
                ),
                outputs: new Map(),
              };
              barrier.publish();
            } else if (
              !malformed.length &&
              (nativeTurn.stopReason === 'end_turn' || text)
            ) {
              const stop = await options.engine.settleTurn({
                assistantText: text,
                ...(reasoning ? { reasoningText: reasoning } : {}),
                stopReason: 'stop',
                toolCallNames: [],
              });
              if (stop) fail(stop.detail, stop.reason);
            }
          }
          if (event.type === 'result') {
            resultSeen = true;
            if (event.is_error) fail(JSON.stringify(event), 'provider_error');
            child!.stdin.end();
          }
        })
        .catch((error) => fail(String(error)));
    }
  });
  history.push({ role: 'user', content: buildInitialUserPrompt(options.ticketDelivery) });
  const first = options.engine.decisionBoundary(history);
  sendUser(first[0]!.content as string);
  await new Promise<void>((resolve) => {
    child!.on('error', (error) => {
      fail(String(error));
      resolve();
    });
    child!.on('close', () => resolve());
  });
  await chain;
  clearTimeout(timer);
  clearInterval(heartbeat);
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!resultSeen && !forced)
    forced = { reason: 'provider_error', detail: 'Claude exited without terminal result' };
  return {
    toolDefinitions: definitions,
    termination: forced?.reason ?? 'agent_finished',
    detail: forced?.detail ?? 'Claude Code completed native session',
    finalAssistantText: finalText,
    piVersion: 'not-applicable',
    activeTools: names,
    resourceIsolation: {
      nativeToolsDisabled: true,
      strictMcpConfig: true,
      skillsDisabled: true,
      effectiveContextCaptured: false,
    },
    runtimeVersion: version,
    runtimeKind: 'claude-code-controlled-mcp',
  };
}
