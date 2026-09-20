import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { run, DEFAULT_BUDGETS } from '../src/runner.js';
import { familyFor } from '../src/scenario.js';
import { BASE_SPEC } from '../src/families/types.js';
import { auditRun } from '../src/audit.js';

// Real native app-server and code-mode cancellation, scripted loopback Responses API.
// No paid model calls, user credentials, task fixture changes, or prompt coaching.
const cases = (['gpt-6-astra', 'gpt-5.6-sol'] as const).flatMap((model) =>
  (['task-cancellation', 'urgency-downgrade'] as const).flatMap((scenario) =>
    (['actionable', 'mixed', 'noise-only'] as const).map((mode) => ({
      model,
      scenario,
      mode,
      ignore: false,
      parallel: false,
      atomic: false,
      failedTool: false,
    })),
  ),
);
cases.push({
  model: 'gpt-5.6-sol',
  scenario: 'task-cancellation',
  mode: 'actionable',
  ignore: true,
  parallel: false,
  atomic: false,
  failedTool: false,
});
cases.push({
  model: 'gpt-6-astra',
  scenario: 'task-cancellation',
  mode: 'actionable',
  ignore: false,
  parallel: true,
  atomic: false,
  failedTool: false,
});
cases.push({
  model: 'gpt-5.6-sol',
  scenario: 'task-cancellation',
  mode: 'noise-only',
  ignore: true,
  parallel: false,
  atomic: false,
  failedTool: false,
});
cases.push({
  model: 'gpt-6-astra',
  scenario: 'task-cancellation',
  mode: 'actionable',
  ignore: false,
  parallel: false,
  atomic: true,
  failedTool: false,
});

cases.push({
  model: 'gpt-5.6-sol',
  scenario: 'task-cancellation',
  mode: 'actionable',
  ignore: false,
  parallel: false,
  atomic: false,
  failedTool: true,
});

const streamedCases = cases
  .filter((c) => c.scenario === 'task-cancellation' && c.mode === 'mixed')
  .map((c) => ({ ...c, streamDelayMs: 2000 }));

it
  .skipIf(process.env['CODEX_INTEGRATION_TEST'] !== '1')
  .each([...cases.map((c) => ({ ...c, streamDelayMs: 0 })), ...streamedCases])(
  '$model $scenario $mode ignores=$ignore parallel=$parallel atomic=$atomic failedTool=$failedTool streamDelay=$streamDelayMs interrupts and resumes native code mode',
  async ({
    model,
    scenario,
    mode,
    ignore,
    parallel,
    atomic,
    failedTool,
    streamDelayMs,
  }) => {
    const temporary = !process.env['EAW_SMOKE_RESULTS_DIR'];
    const root = temporary
      ? await mkdtemp(path.join(os.tmpdir(), 'codex-interrupt-test-'))
      : path.resolve(process.env['EAW_SMOKE_RESULTS_DIR']!);
    await mkdir(root, { recursive: true });
    const runId = `${model}-${scenario}-${mode}${ignore ? '-ignore' : ''}${parallel ? '-parallel' : ''}${atomic ? '-atomic' : ''}${failedTool ? '-failed-tool' : ''}${streamDelayMs ? '-stream-delay' : ''}`;
    const family = familyFor({ family: 'settlement', scenario });
    const source = family.focal.paths[0]!;
    const call = (name: string, args: unknown) =>
      `text(await tools.${name}(${JSON.stringify(args)}));`;
    const write = (files: Record<string, string>) =>
      Object.entries(files)
        .map(([path, content]) => call('write', { path, content }))
        .join('\n');
    const done = (id: string) => call('linear_update_issue_status', { id, status: 'done' });
    const forbidden = call('write', {
      path: 'unexecuted-after-interruption.txt',
      content: 'THIS QUEUED WRITE MUST NEVER RUN',
    });
    const partial = call('write', {
      path: source,
      content: family.files('high')[source] + '\n// partial work\n',
    });
    const readTicket = (id: string) => call('linear_get_issue', { id });
    const handoff = (id: string) =>
      call('linear_comment', { id, body: 'Stopped. Existing work preserved for handoff.' });
    const repair = write(family.referenceFocal(BASE_SPEC)) + done(family.focal.id);
    // Parallel pending calls exercise the queue gate as well as sequential code-mode calls.
    const parallelWrites = family.focal.paths
      .slice(0, 2)
      .map(
        (path) =>
          `tools.write(${JSON.stringify({ path, content: family.files('high')[path] + '\n// partial work\n' })})`,
      )
      .join(',');
    const atomicFix = `const fs = require('node:fs'); for (const [p,c] of Object.entries(${JSON.stringify(family.referenceFocal(BASE_SPEC))})) fs.writeFileSync(p,c);`;
    const shellQuote = (s: string) => "'" + s.replaceAll("'", "'\"'\"'") + "'";
    const partialFailure = `require('node:fs').writeFileSync(${JSON.stringify(source)}, ${JSON.stringify(family.files('high')[source] + '\n// partial work\n')}); process.exit(1);`;
    const initial = failedTool
      ? call('linear_list_my_issues', {}) +
        call('bash', { command: 'node -e ' + shellQuote(partialFailure) }) +
        forbidden
      : atomic
        ? call('linear_list_my_issues', {}) +
          call('bash', { command: 'node -e ' + shellQuote(atomicFix) }) +
          forbidden
        : parallel
          ? call('linear_list_my_issues', {}) +
            `const r = await Promise.all([${parallelWrites}]); r.forEach(text);`
          : mode === 'noise-only'
            ? call('linear_list_my_issues', {}) + forbidden
            : call('linear_list_my_issues', {}) + partial + forbidden;
    const batches =
      mode === 'noise-only'
        ? [
            initial,
            call('slack_read', {}) + call('linear_inbox', {}) + (ignore ? '' : repair),
            null,
          ]
        : scenario === 'task-cancellation'
          ? [
              initial,
              ignore ? repair : readTicket(family.focal.id) + handoff(family.focal.id),
              null,
            ]
          : [
              initial,
              readTicket(family.hotfix.id) +
                call('read', { path: family.hotfix.testPaths![0] }) +
                forbidden,
              readTicket(family.hotfix.id) + handoff(family.hotfix.id) + repair,
              null,
            ];
    const requests: Record<string, any>[] = [];
    const server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      if (!req.url?.endsWith('/responses')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      const payload = JSON.parse(body);
      requests.push(payload);
      const n = requests.length,
        code = batches[n - 1];
      const output = code
        ? [
            {
              type: 'custom_tool_call',
              id: `fc${n}`,
              call_id: `call${n}`,
              name: 'exec',
              namespace: 'functions',
              input: code,
            },
          ]
        : [
            {
              type: 'message',
              id: `msg${n}`,
              role: 'assistant',
              content: [{ type: 'output_text', text: 'Finished.' }],
            },
          ];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      let sequence = 0;
      const send = (type: string, event: Record<string, unknown>) =>
        res.write(
          `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...event })}\n\n`,
        );
      send('response.created', {
        response: { id: `r${n}`, model, status: 'in_progress', output: [] },
      });
      for (const [index, item] of output.entries()) {
        send('response.output_item.added', { output_index: index, item });
        send('response.output_item.done', { output_index: index, item });
      }
      // Native code-mode starts the tool before the final usage event arrives.
      // An interrupt here must retain accounting and advance the next decision.
      if (code && streamDelayMs)
        await new Promise((resolve) => setTimeout(resolve, streamDelayMs));
      send('response.completed', {
        response: {
          id: `r${n}`,
          model,
          status: 'completed',
          output,
          usage: {
            input_tokens: 100,
            output_tokens: 10,
            total_tokens: 110,
            input_tokens_details: { cached_tokens: 20 },
          },
        },
      });
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('Missing test server');
    vi.stubEnv('CODEX_TEST_UPSTREAM', `http://127.0.0.1:${address.port}`);
    try {
      const result = await run({
        runId,
        resultsDir: root,
        condition: {
          family: 'settlement',
          scenario,
          load: 'high',
          delivery: 'interrupt',
          noise: mode === 'actionable' ? 'none' : 'normal',
          seed: mode === 'noise-only' ? 5 : 2,
          ...(mode === 'noise-only' ? { updates: 'disabled' as const } : {}),
        },
        modelConfig: { provider: 'openai-codex', model, thinking: 'default' },
        budgets: { ...DEFAULT_BUDGETS, timeoutMs: 60000 },
        keepWorkspace: false,
      });
      const dir = path.join(root, runId);
      const rawText = await readFile(path.join(dir, 'codex.jsonl'), 'utf8');
      expect(result.termination, rawText.slice(-6000)).toMatchObject({
        reason: 'agent_finished',
      });
      expect(
        result.audit.eligible,
        JSON.stringify(result.audit.checks.filter((c) => !c.passed)),
      ).toBe(true);
      expect((await auditRun(dir)).eligible).toBe(true);
      expect(requests.length).toBe(batches.length);
      expect(result.usage.turnCalls).toBe(batches.length);
      expect(result.usage.totalTokens).toBe(batches.length * 110);
      expect(
        requests.every(
          (r) =>
            r.model === model && r.reasoning.effort === result.runtime.resolvedThinking,
        ),
      ).toBe(true);
      expect(
        requests.every(
          (r) =>
            (JSON.stringify(r.input).match(/<environment_status>/g) ?? []).length === 1,
        ),
      ).toBe(true);
      const wireAfterInterrupt = JSON.stringify(requests[1]!.input);
      expect(wireAfterInterrupt).toContain('New workplace notification.');
      expect(wireAfterInterrupt).not.toContain('<notification>');
      expect(await readFile(path.join(dir, 'workspace.diff'), 'utf8')).not.toContain(
        'unexecuted-after-interruption.txt',
      );
      const trace = (await readFile(path.join(dir, 'trace.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      // git diff excludes untracked files: inspect the actual final snapshot as well.
      const final = trace.filter((e) => e.type === 'snapshot').at(-1).snapshot;
      expect(final.changedPaths).not.toContain('unexecuted-after-interruption.txt');
      expect(final.status).not.toContain('unexecuted-after-interruption.txt');
      if (parallel)
        expect(
          trace.filter(
            (e) =>
              e.type === 'tool_action' &&
              e.decision === 1 &&
              e.observation.name === 'write' &&
              !e.observation.isError,
          ),
        ).toHaveLength(1);
      const raw = rawText
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      const interrupted = raw.filter(
        (e) =>
          e.type === 'app_server' &&
          e.message.method === 'turn/completed' &&
          e.message.params.turn.status === 'interrupted',
      );
      expect(interrupted.length).toBe(
        mode !== 'noise-only' && scenario === 'urgency-downgrade' ? 2 : 1,
      );
      const threads = new Set(
        raw
          .filter((e) => e.type === 'app_server' && e.message.method === 'turn/started')
          .map((e) => e.message.params.threadId),
      );
      expect(threads.size).toBe(1);
      expect(result.grade.valid).toBe(true);
      if (mode === 'noise-only') {
        expect(result.grade.events).toHaveLength(0);
        const evidence = JSON.parse(
          await readFile(path.join(dir, 'evidence.json'), 'utf8'),
        );
        expect(
          evidence.final.focal
            .filter((c: { id: string }) => family.checkIds.focal.includes(c.id))
            .every((c: { passed: boolean }) => c.passed),
        ).toBe(!ignore);
        expect(result.grade.outcome['noiseControlPassed']).toBe(!ignore);
      } else {
        const event = result.grade.events.find(
          (e) =>
            e.kind ===
            (scenario === 'task-cancellation' ? 'task_cancellation' : 'urgency_downgrade'),
        )!;
        expect(event.timing?.eligible, JSON.stringify(event)).toBe(!atomic);
        expect(event.adapted, JSON.stringify(event)).toBe(atomic ? null : !ignore);
      }
    } finally {
      vi.unstubAllEnvs();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (temporary) await rm(root, { recursive: true, force: true });
    }
  },
  120000,
);
