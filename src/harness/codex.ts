import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import type { Engine } from '../engine.js';
import type { Budgets } from '../runner.js';
import { definitions } from '../tools.js';
import type { UsageMeter } from '../usage.js';
import type { ModelSelection } from './model.js';
import type { ControlledTools } from './repo-tools.js';
import { sha256 } from './identity.js';

type ObjectValue = Record<string, any>;
const exec = promisify(execFile);
const codexHome = () => process.env['CODEX_HOME'] ?? path.join(os.homedir(), '.codex');
const synthetic = () => process.env['CODEX_INTEGRATION_TEST'] === '1';
const pooled = () =>
  !synthetic() &&
  Boolean(process.env['CODEX_OPENAI_BASE_URL'] && process.env['CODEX_POOL_AUTH_TOKEN']);
export const CODEX_CONTEXT_NOTE =
  'Native Codex with its default code-mode runtime. Context capture contains the injected observation and model outputs; codex.jsonl includes model request bodies, response items, and app-server events, without HTTP credentials. Workspace tools run in the same isolated fixture as Claude Code. Unread indicators are inserted at the model transport boundary. Interrupt delivery additionally checks events after individual controlled tools, cancels the native turn and queued tools, and resumes the same thread with a generic notification.';

export async function verifyCodex(selection: ModelSelection) {
  if (selection.provider !== 'openai-codex') throw Error('Expected a Codex model');
  const { stdout } = await exec('codex', ['--version'], { timeout: 15_000 });
  if (!synthetic() && !pooled()) {
    const auth = await exec('codex', ['login', 'status'], { timeout: 15_000 });
    if (!/Logged in/i.test(auth.stdout + auth.stderr))
      throw Error('Log in with codex login');
  }
  const cache = JSON.parse(
    await readFile(path.join(codexHome(), 'models_cache.json'), 'utf8'),
  );
  const model = cache.models.find((m: ObjectValue) => m.slug === selection.model);
  if (!model) throw Error('Selected model is absent from the native Codex catalog');
  const resolvedThinking =
    selection.thinking === 'default' ? model.default_reasoning_level : selection.thinking;
  if (
    !model.supported_reasoning_levels.some(
      (r: ObjectValue) => r.effort === resolvedThinking,
    )
  )
    throw Error('Selected reasoning level is unavailable in Codex');
  let cost: ObjectValue | undefined;
  let pricingCheckedAt: string | undefined;
  if (!synthetic()) {
    // Pricing metadata only: Pi never runs the agent or makes an inference request here.
    const prices = JSON.parse(
      await readFile(path.join(getAgentDir(), 'models-store.json'), 'utf8'),
    )['openai-codex'];
    cost = prices?.models.find(
      (m: ObjectValue) => m.id === selection.model && m.provider === selection.provider,
    )?.cost;
    pricingCheckedAt = prices?.checkedAt
      ? new Date(prices.checkedAt).toISOString()
      : undefined;
    if (!cost || !cost.input || !cost.output)
      throw Error('Selected model cached pricing unavailable');
  }
  return {
    agent: 'codex',
    agentVersion: stdout.trim(),
    ...selection,
    requested: { ...selection },
    resolvedThinking,
    nativeToolMode: model.tool_mode,
    nativeModelCatalogSha256: sha256(JSON.stringify(cache.models)),
    api: 'codex-app-server',
    authSource: pooled() ? 'bb-account-pool' : 'codex',
    fallbackPolicy: 'none',
    contextCapture: 'codex-transport-observer',
    outputBudgetTransport: 'native-default',
    maxOutputTokens: null,
    maxOutputTokensEnforced: false,
    usageSource: 'codex-responses-completions',
    callCountsScope: 'observed-responses-and-compaction',
    retriesManagedBy: 'codex',
    pricing: 'cached-catalog-estimate',
    catalogSource: 'local Pi model catalog; not a provider bill',
    catalogCost: cost ?? { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1 },
    ...(pricingCheckedAt ? { pricingCheckedAt } : {}),
    transport: 'http-sse-observer',
    environments: 'disabled; controlled workspace tools only',
    providerRouting: pooled()
      ? 'native custom-provider entry uses the existing BB Codex account-pool route'
      : 'native custom-provider entry forwards only to the Codex ChatGPT backend',
    ...(synthetic() ? { synthetic: true } : {}),
  };
}

class Rpc {
  child: ChildProcessWithoutNullStreams;
  nextId = 0;
  pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  constructor(
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    readonly incoming: (message: ObjectValue) => void,
    readonly stderr: (text: string) => void,
    readonly failed: (error: Error) => void,
  ) {
    this.child = spawn('codex', ['app-server', '--stdio', ...args], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stderr.on('data', (b) => stderr(String(b)));
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      try {
        const m = JSON.parse(line);
        if (m.method) incoming(m);
        else {
          const p = this.pending.get(m.id);
          if (!p) return;
          clearTimeout(p.timer);
          this.pending.delete(m.id);
          if (m.error) p.reject(Error(JSON.stringify(m.error)));
          else p.resolve(m.result);
        }
      } catch (e) {
        failed(e as Error);
      }
    });
    this.child.on('error', failed);
    this.child.on('exit', (code, signal) => {
      const error = Error(`Codex exited ${code ?? signal}`);
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(error);
      }
      this.pending.clear();
      if (signal !== 'SIGTERM') failed(error);
    });
  }
  send(message: unknown) {
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }
  call(method: string, params: unknown): Promise<any> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error('Codex RPC timeout: ' + method));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }
  close() {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(Error('Codex closed'));
    }
    this.pending.clear();
    this.child.kill('SIGTERM');
  }
}

export function codexMessage(
  response: ObjectValue,
  observations: ObjectValue[],
  cost: ObjectValue,
) {
  const u = response.usage ?? {};
  const tier = [...(cost.tiers ?? [])]
    .reverse()
    .find((t) => (u.input_tokens ?? 0) > t.inputTokensAbove);
  cost = { ...cost, ...tier };
  const cached = u.input_tokens_details?.cached_tokens ?? 0;
  const write = u.input_tokens_details?.cache_write_tokens ?? 0;
  const input = Math.max(0, (u.input_tokens ?? 0) - cached - write),
    output = u.output_tokens ?? 0;
  const amounts = {
    input: (input * cost.input) / 1e6,
    output: (output * cost.output) / 1e6,
    cacheRead: (cached * cost.cacheRead) / 1e6,
    cacheWrite: (write * cost.cacheWrite) / 1e6,
  };
  const blocks: ObjectValue[] = [];
  for (const item of response.output ?? []) {
    if (item.type === 'message')
      for (const b of item.content ?? [])
        if (b.text) blocks.push({ type: 'text', text: b.text });
    if (item.type === 'reasoning')
      for (const b of item.summary ?? [])
        if (b.text) blocks.push({ type: 'thinking', thinking: b.text });
    if (item.type === 'custom_tool_call') blocks.push({ type: 'text', text: item.input });
  }
  // Inner workspace calls are the actions the grader observes. Keep the native outer
  // calls in codex.jsonl and in text above; a code-mode call with no workspace action
  // still counts as a continuing model decision.
  for (const o of observations)
    blocks.push({ type: 'toolCall', id: o.id, name: o.name, arguments: o.args });
  const outerCalls = (response.output ?? []).filter((i: ObjectValue) =>
    ['function_call', 'custom_tool_call', 'tool_search_call'].includes(i.type),
  );
  if (!observations.length)
    for (const c of outerCalls)
      blocks.push({
        type: 'toolCall',
        id: c.call_id ?? c.id,
        name: c.name ?? c.type,
        arguments: c.arguments ?? c.input ?? {},
      });
  return {
    role: 'assistant',
    model: response.model,
    content: blocks,
    stopReason:
      response.status === 'incomplete' ? 'length' : outerCalls.length ? 'toolUse' : 'stop',
    usage: {
      input,
      output,
      cacheRead: cached,
      cacheWrite: write,
      reasoning: u.output_tokens_details?.reasoning_tokens ?? null,
      totalTokens: u.total_tokens ?? input + output + cached + write,
      cost: { ...amounts, total: Object.values(amounts).reduce((a, b) => a + b, 0) },
    },
  };
}

export async function runCodex(options: {
  selection: ModelSelection;
  verification: Awaited<ReturnType<typeof verifyCodex>>;
  cwd: string;
  systemPrompt: string;
  initialPrompt: string;
  tools: ControlledTools;
  engine: Engine;
  meter: UsageMeter;
  budgets: Budgets;
  abortController: AbortController;
  afterTurn: (message: unknown) => Promise<void>;
  afterTool: () => Promise<string[]>;
  stop: (reason: string, detail: string) => void;
  persist: (event: unknown) => void;
}) {
  const { selection, engine, abortController, verification } = options;
  const interruptMode = engine.condition.delivery === 'interrupt';
  const home = path.join(options.cwd, 'codex-home');
  await mkdir(home, { recursive: true });
  await copyFile(
    path.join(codexHome(), 'models_cache.json'),
    path.join(home, 'models_cache.json'),
  );
  if (!synthetic() && !pooled())
    await copyFile(path.join(codexHome(), 'auth.json'), path.join(home, 'auth.json'));
  else if (synthetic()) {
    const claims = {
      sub: 'synthetic-user',
      exp: Math.floor(Date.now() / 1000) + 86400,
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'synthetic-account',
        chatgpt_plan_type: 'team',
        chatgpt_user_id: 'synthetic-user',
      },
    };
    const jwt =
      Buffer.from('{"alg":"none"}').toString('base64url') +
      '.' +
      Buffer.from(JSON.stringify(claims)).toString('base64url') +
      '.synthetic';
    await writeFile(
      path.join(home, 'auth.json'),
      JSON.stringify({
        auth_mode: 'chatgpt',
        OPENAI_API_KEY: null,
        tokens: {
          id_token: jwt,
          access_token: jwt,
          refresh_token: 'synthetic',
          account_id: 'synthetic-account',
        },
        last_refresh: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );
  }
  const cache = JSON.parse(await readFile(path.join(home, 'models_cache.json'), 'utf8'));
  if (sha256(JSON.stringify(cache.models)) !== verification.nativeModelCatalogSha256)
    throw Error('Native model catalog changed after verification');
  options.persist({
    type: 'native_model_catalog',
    model: cache.models.find((m: ObjectValue) => m.slug === selection.model),
  });
  await writeFile(
    path.join(home, 'catalog.json'),
    JSON.stringify({ models: cache.models }),
  );
  const defs = definitions(options.tools);
  let client: Rpc | undefined, server: Server | undefined;
  let response: ObjectValue | undefined,
    responseItems: ObjectValue[] = [],
    observations: ObjectValue[] = [];
  let inputOpen = false,
    lastInjected: string | undefined,
    attempt = 0,
    ended = false;
  let finalStatus = { reason: 'agent_finished', detail: 'Codex ended its turn' };
  let threadId = '',
    activeTurnId = '';
  let toolAbort = new AbortController();
  let interruption:
    { turnId: string; eventIds: string[]; ack: Promise<unknown> } | undefined;
  let resuming = false;
  let responseReady: (() => void) | undefined;
  let end!: () => void;
  const finished = new Promise<void>((resolve) => {
    end = resolve;
  });
  const fail = (reason: string, error: unknown) => {
    if (ended) return;
    ended = true;
    finalStatus = { reason, detail: String(error) };
    responseReady?.();
    options.stop(reason, String(error));
    end();
  };
  const flush = async () => {
    if (!inputOpen || !response) return;
    await options.tools.idle();
    const message = codexMessage(response, observations, verification.catalogCost);
    options.meter.add(message, 'turn');
    inputOpen = false;
    response = undefined;
    responseItems = [];
    observations = [];
    if (options.meter.totals.totalTokens > options.budgets.maxTotalTokens) {
      message.stopReason = 'aborted';
      options.stop('token_budget', 'Run token budget reached');
    }
    await options.afterTurn(message);
  };
  const resumeInterrupted = async () => {
    if (resuming || !interruption) throw Error('Unexpected duplicate interruption');
    resuming = true;
    const saved = interruption;
    await saved.ack;
    await options.tools.idle();
    await flush();
    if (abortController.signal.aborted) return;
    engine.emit({
      type: 'interruption',
      phase: 'resumed',
      eventIds: saved.eventIds,
      turnId: saved.turnId,
    });
    options.persist({
      type: 'notification_resume',
      decision: engine.decision,
      ...{ turnId: saved.turnId, eventIds: saved.eventIds },
    });
    interruption = undefined;
    activeTurnId = '';
    toolAbort = new AbortController();
    resuming = false;
    await client!.call('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'New workplace notification.', text_elements: [] }],
    });
  };
  if (interruptMode)
    options.tools.afterEach = async () => {
      // A failed shell command may still have changed source before its failing test.
      // Skip canceled calls, but snapshot ordinary tool failures as well as successes.
      if (toolAbort.signal.aborted || interruption || abortController.signal.aborted)
        return;
      let eventIds: string[];
      try {
        eventIds = await options.afterTool();
      } catch (error) {
        toolAbort.abort();
        throw error;
      }
      if (!eventIds.length) return;
      if (!threadId || !activeTurnId) throw Error('Missing native turn for interruption');
      // This callback holds the serialized tool queue. Cancel its old signal before
      // returning so even already-submitted parallel calls cannot perform more work.
      toolAbort.abort();
      // Native code mode can start tools before the response's final SSE usage
      // record arrives. Keep the workspace queue canceled while that stream
      // finishes, so interruption cannot discard the response or turn the next
      // turn into a retry with the old unread indicator.
      if (!response) {
        await new Promise<void>((resolve, reject) => {
          const finish = () => {
            abortController.signal.removeEventListener('abort', finish);
            responseReady = undefined;
            if (response) resolve();
            else reject(new Error('Response stream ended before interruption accounting'));
          };
          responseReady = finish;
          abortController.signal.addEventListener('abort', finish, { once: true });
          if (response || ended || abortController.signal.aborted) finish();
        });
      }
      engine.emit({
        type: 'interruption',
        phase: 'requested',
        eventIds,
        turnId: activeTurnId,
      });
      options.persist({
        type: 'notification_interrupt',
        decision: engine.decision,
        turnId: activeTurnId,
        eventIds,
      });
      interruption = {
        turnId: activeTurnId,
        eventIds,
        ack: client!.call('turn/interrupt', { threadId, turnId: activeTurnId }),
      };
      await interruption.ack;
    };
  const recordSse = (event: ObjectValue) => {
    if (event.type === 'response.output_item.done') responseItems.push(event.item);
    if (event.type === 'response.completed' || event.type === 'response.incomplete') {
      const r = event.response;
      if (r.model && r.model !== selection.model)
        throw Error('Codex response model mismatch: ' + r.model);
      response = {
        ...r,
        output: r.output?.length ? r.output : responseItems,
        model: r.model ?? selection.model,
      };
      responseReady?.();
    }
  };
  // Observe the native HTTP transport, keeping native code-mode execution intact.
  // The next request cannot reach the provider until the previous batch is snapshotted.
  // Only the eval's observation is appended; native instructions, tools, history,
  // reasoning effort, retries, and compaction remain under Codex's control.
  server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const url = req.url ?? '/';
      const isDecision = req.method === 'POST' && /\/responses(?:\?|$)/.test(url);
      const isCompaction =
        req.method === 'POST' && /\/responses\/compact(?:\?|$)/.test(url);
      let outgoing: Uint8Array<ArrayBuffer> | string = new Uint8Array(body);
      if (isDecision) {
        const payload = JSON.parse(body.toString());
        if (payload.model !== selection.model)
          throw Error('Codex requested a different model');
        if (payload.reasoning?.effort !== verification.resolvedThinking)
          throw Error('Codex reasoning differs from selected native default');
        // A yielded code-mode cell can continue executing while the model decides.
        // Until that case has an explicit scheduling protocol, fail closed instead
        // of silently assigning its later edits to another decision.
        if (
          payload.input.some(
            (item: ObjectValue) =>
              item.type === 'custom_tool_call_output' &&
              /Script running with cell ID/.test(JSON.stringify(item.output)),
          )
        )
          throw Error('Background code-mode cells are not supported by the batch observer');
        await flush();
        if (abortController.signal.aborted) throw Error('Run stopped');
        if (!inputOpen) {
          const [context] = engine.beforeDecision([{ role: 'user', content: '' }]);
          lastInjected = String(context!.content);
          inputOpen = true;
          attempt = 0;
        } else {
          engine.emit({
            type: 'provider_retry',
            attempt: ++attempt,
            maxAttempts: options.budgets.providerRetries,
            delayMs: 0,
            errorMessage: 'Codex retried an unfinished response',
          });
          if (attempt > options.budgets.providerRetries) {
            fail('provider_error', 'Native Codex retry guard exceeded');
            throw Error('Run stopped');
          }
        }
        responseItems = [];
        payload.input.push({
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: lastInjected }],
        });
        options.persist({
          type: 'model_request',
          decision: engine.decision,
          body: payload,
        });
        outgoing = JSON.stringify(payload);
      }
      const upstream = synthetic()
        ? process.env['CODEX_TEST_UPSTREAM']
        : pooled()
          ? process.env['CODEX_OPENAI_BASE_URL']
          : 'https://chatgpt.com/backend-api';
      if (!upstream) throw Error('Missing synthetic upstream');
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (
          value !== undefined &&
          !['host', 'content-length', 'connection', 'accept-encoding'].includes(name)
        )
          headers.set(name, Array.isArray(value) ? value.join(', ') : value);
      }
      let upstreamResponse: Response;
      try {
        upstreamResponse = await fetch(
          upstream.replace(/\/$/, '') +
            (pooled() ? url.replace(/^\/codex(?=\/|$)/, '') : url),
          {
            method: req.method ?? 'GET',
            headers,
            ...(req.method !== 'GET' && req.method !== 'HEAD' ? { body: outgoing } : {}),
            signal: abortController.signal,
          },
        );
      } catch (error) {
        if (abortController.signal.aborted) throw error;
        options.persist({ type: 'transport_error', error: String(error) });
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: { message: 'Codex upstream connection failed', type: 'server_error' },
          }),
        );
        return;
      }
      res.statusCode = upstreamResponse.status;
      upstreamResponse.headers.forEach((value, name) => {
        if (
          ![
            'content-length',
            'content-encoding',
            'transfer-encoding',
            'connection',
          ].includes(name)
        )
          res.setHeader(name, value);
      });
      let pending = '';
      let compactBody = '';
      const decoder = new TextDecoder();
      if (upstreamResponse.body) {
        const reader = upstreamResponse.body.getReader();
        while (true) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          if (isCompaction) compactBody += Buffer.from(chunk).toString('utf8');
          if (isDecision && upstreamResponse.ok) {
            pending += decoder.decode(chunk, { stream: true });
            let boundary: number;
            let separator: RegExpExecArray | null;
            while ((separator = /\r?\n\r?\n/.exec(pending)) !== null) {
              boundary = separator.index;
              const block = pending.slice(0, boundary);
              pending = pending.slice(boundary + separator[0].length);
              const data = block
                .split('\n')
                .filter((l) => l.startsWith('data:'))
                .map((l) => l.slice(5).trim())
                .join('\n');
              if (data && data !== '[DONE]') {
                const e = JSON.parse(data);
                recordSse(e);
                options.persist({
                  type: 'model_response_event',
                  decision: engine.decision,
                  event: e,
                });
              }
            }
          }
          res.write(chunk);
        }
      }
      if (isCompaction) {
        const compact = JSON.parse(compactBody);
        options.persist({
          type: 'compaction_response',
          status: upstreamResponse.status,
          body: compact,
        });
        const message = codexMessage(compact, [], verification.catalogCost);
        if (!upstreamResponse.ok) message.stopReason = 'error';
        options.meter.add(message, 'summary');
        if (options.meter.totals.totalTokens > options.budgets.maxTotalTokens)
          options.stop('token_budget', 'Run token budget reached during compaction');
      }
      res.end();
    } catch (e) {
      res.destroy(e as Error);
      if (!abortController.signal.aborted) fail('harness_error', e);
    }
  });
  // The native built-in provider is immutable. Explicitly reject WebSocket
  // upgrades so its supported HTTP fallback passes through the observer.
  server.on('upgrade', (_req, socket) =>
    socket.end(
      'HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
    ),
  );
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw Error('Missing Codex observer address');
  const proxy = `http://127.0.0.1:${address.port}`;
  const config: ObjectValue = {
    web_search: 'disabled',
    features: {
      apps: false,
      plugins: false,
      multi_agent: false,
      memories: false,
      enable_request_compression: false,
      hooks: false,
    },
    chatgpt_base_url: proxy,
    model_provider: 'eval_observed',
    model_providers: {
      eval_observed: {
        name: 'Codex eval transport observer',
        base_url: proxy + (synthetic() ? '/v1' : '/codex'),
        wire_api: 'responses',
        requires_openai_auth: !pooled(),
        ...(pooled() ? { env_key: 'CODEX_POOL_AUTH_TOKEN' } : {}),
        supports_websockets: false,
      },
    },
    ...(selection.thinking === 'default'
      ? {}
      : { model_reasoning_effort: selection.thinking }),
    ...(options.budgets.compaction
      ? {}
      : { model_auto_compact_token_limit: 2_000_000_000 }),
  };
  config.model_catalog_json = path.join(home, 'catalog.json');
  const args = Object.entries(config).flatMap(([key, value]) => [
    '-c',
    `${key}=${toml(value)}`,
  ]);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'],
    HOME: process.env['HOME'],
    LANG: process.env['LANG'],
    TZ: process.env['TZ'],
    CODEX_HOME: home,
    OPENAI_BASE_URL: proxy + (synthetic() ? '/v1' : '/codex'),
    ...(pooled() ? { CODEX_POOL_AUTH_TOKEN: process.env['CODEX_POOL_AUTH_TOKEN'] } : {}),
  };
  const stopped = () => {
    if (!ended) {
      ended = true;
      end();
    }
  };
  abortController.signal.addEventListener('abort', stopped, { once: true });
  try {
    client = new Rpc(
      args,
      options.cwd,
      env,
      (m) => {
        options.persist({ type: 'app_server', message: m });
        if (m.method === 'item/tool/call') {
          void (async () => {
            const p = m.params;
            if (interruptMode && (p.turnId !== activeTurnId || interruption || resuming)) {
              options.persist({
                type: 'canceled_tool_request',
                turnId: p.turnId,
                callId: p.callId,
              });
              client!.send({
                id: m.id,
                result: {
                  contentItems: [
                    {
                      type: 'inputText',
                      text: 'Tool canceled by notification interruption.',
                    },
                  ],
                  success: false,
                },
              });
              return;
            }
            if (!inputOpen)
              throw Error(
                'Codex bypassed the model-request observer; refusing workspace action',
              );
            if (!defs.some((d) => d.name === p.tool) || p.namespace)
              throw Error('Unexpected workspace tool: ' + p.tool);
            const o = await options.tools.run(
              p.callId,
              p.tool,
              p.arguments,
              interruptMode
                ? AbortSignal.any([abortController.signal, toolAbort.signal])
                : abortController.signal,
            );
            observations.push(o);
            client!.send({
              id: m.id,
              result: {
                contentItems: [{ type: 'inputText', text: JSON.stringify(o.value) }],
                success: !o.isError,
              },
            });
          })().catch((e) => fail('harness_error', e));
        } else if (m.method === 'turn/started') {
          activeTurnId = m.params.turn.id;
        } else if (m.id !== undefined) {
          client!.send({
            id: m.id,
            error: { code: -32601, message: 'Unsupported eval capability' },
          });
          fail('harness_error', 'Unexpected Codex server request: ' + m.method);
        } else if (m.method === 'model/rerouted')
          fail('provider_error', 'Codex model fallback refused');
        else if (m.method === 'thread/compacted')
          engine.emit({ type: 'compaction', phase: 'end', reason: 'native-auto' });
        else if (m.method === 'item/started' && m.params.item.type === 'contextCompaction')
          engine.emit({ type: 'compaction', phase: 'start', reason: 'native-auto' });
        else if (m.method === 'turn/completed') {
          if (
            interruptMode &&
            interruption &&
            m.params.turn.id === interruption.turnId &&
            m.params.turn.status === 'interrupted'
          ) {
            void resumeInterrupted().catch((e) => fail('harness_error', e));
            return;
          }
          if (m.params.turn.status !== 'completed')
            finalStatus = {
              reason: 'provider_error',
              detail: JSON.stringify(m.params.turn.error ?? m.params.turn.status),
            };
          ended = true;
          end();
        }
      },
      (text) => options.persist({ type: 'stderr', text }),
      (e) => fail('provider_error', e),
    );
    await client.call('initialize', {
      clientInfo: { name: 'environment_awareness_eval', version: '1.0' },
      capabilities: { experimentalApi: true },
    });
    client.send({ method: 'initialized' });
    const skills = await client.call('skills/list', { cwds: [options.cwd] });
    const disabled = skills.data.flatMap((d: ObjectValue) =>
      d.skills.map((s: ObjectValue) => ({ path: s.path, enabled: false })),
    );
    const start = await client.call('thread/start', {
      model: selection.model,
      allowProviderModelFallback: false,
      cwd: options.cwd,
      ephemeral: true,
      environments: [],
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      runtimeWorkspaceRoots: ['/workspace/repo'],
      baseInstructions: options.systemPrompt,
      experimentalRawEvents: true,
      config: {
        skills: { config: disabled },
        sandbox_workspace_write: {
          writable_roots: ['/workspace/repo'],
          network_access: false,
          exclude_slash_tmp: true,
          exclude_tmpdir_env_var: true,
        },
      },
      dynamicTools: defs.map((d) => ({
        type: 'function',
        name: d.name,
        description: d.description,
        inputSchema: d.parameters,
        deferLoading: false,
      })),
    });
    if (start.model !== selection.model) throw Error('Codex thread model mismatch');
    threadId = start.thread.id;
    await client.call('turn/start', {
      threadId: start.thread.id,
      input: [{ type: 'text', text: options.initialPrompt, text_elements: [] }],
    });
    await finished;
    await flush();
    if (engine.decision === 0 && finalStatus.reason === 'agent_finished')
      finalStatus = {
        reason: 'harness_error',
        detail: 'Codex completed without an observed model request',
      };
    if (inputOpen) {
      inputOpen = false;
      const message = {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: finalStatus.detail,
      };
      options.meter.add(message, 'turn');
      await options.afterTurn(message);
    }
    return finalStatus;
  } finally {
    delete options.tools.afterEach;
    toolAbort.abort();
    abortController.signal.removeEventListener('abort', stopped);
    client?.close();
    server.closeAllConnections();
    await options.tools.idle();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
  }
}

function toml(value: any): string {
  if (value === null) throw Error('TOML null is unsupported');
  if (Array.isArray(value)) return '[' + value.map(toml).join(',') + ']';
  if (typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .map(([k, v]) => JSON.stringify(k) + '=' + toml(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
