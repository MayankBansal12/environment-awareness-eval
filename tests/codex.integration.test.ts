import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { run, DEFAULT_BUDGETS } from '../src/runner.js';
import { familyFor, type Scenario } from '../src/scenario.js';
import { BASE_SPEC } from '../src/families/types.js';

// Opt-in native app-server + code-mode + bwrap integration. All model responses
// come from this loopback fake API; no provider credentials or inference are used.
it.skipIf(process.env['CODEX_INTEGRATION_TEST'] !== '1').each([
  { scenario: 'updates', model: 'gpt-6-astra', effort: 'medium', budget: 100000 },
  { scenario: 'task-cancellation', model: 'gpt-5.6-sol', effort: 'low', budget: 100000 },
  { scenario: 'urgency-downgrade', model: 'gpt-6-astra', effort: 'medium', budget: 100000 },
  { scenario: 'delayed-relevance', model: 'gpt-5.6-sol', effort: 'low', budget: 100000 },
  { scenario: 'updates', model: 'gpt-5.6-sol', effort: 'low', budget: 100 },
] as const)(
  'runs native Codex $model/$scenario with default effort and budget $budget',
  async ({ scenario, model, budget }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'codex-eval-test-'));
    const family = familyFor({ family: 'settlement', scenario: scenario as Scenario });
    const catalog = JSON.parse(
      await readFile(
        path.join(
          process.env['CODEX_HOME'] ?? path.join(os.homedir(), '.codex'),
          'models_cache.json',
        ),
        'utf8',
      ),
    );
    const effort = catalog.models.find(
      (m: { slug: string }) => m.slug === model,
    ).default_reasoning_level;
    const focalPath = family.focal.paths[0]!;
    const call = (name: string, args: unknown) =>
      `text(await tools.${name}(${JSON.stringify(args)}));`;
    const writeSources = (files: Record<string, string>) =>
      Object.entries(files)
        .map(([path, content]) => call('write', { path, content }))
        .join('\n');
    const done = (id: string) => call('linear_update_issue_status', { id, status: 'done' });
    const handoff = (id: string) =>
      call('linear_comment', { id, body: 'Work stopped and preserved for handoff.' });
    const initial =
      call('linear_list_my_issues', {}) +
      call('write', {
        path: focalPath,
        content: family.files('high')[focalPath] + '\n// work in progress\n',
      });
    const batches =
      scenario === 'updates'
        ? [
            // Parallel read-only inner calls still make one model decision.
            'const r = await Promise.all([tools.linear_list_my_issues({}), tools.ls({})]); r.forEach(text);',
            initial,
            call('linear_get_issue', { id: family.focal.id }),
            null,
          ]
        : scenario === 'task-cancellation'
          ? [
              initial,
              call('linear_get_issue', { id: family.focal.id }) + handoff(family.focal.id),
              null,
            ]
          : scenario === 'urgency-downgrade'
            ? [
                initial,
                call('linear_get_issue', { id: family.hotfix.id }) +
                  call('read', { path: family.hotfix.testPaths![0] }),
                call('linear_get_issue', { id: family.hotfix.id }) +
                  handoff(family.hotfix.id),
                writeSources(family.referenceFocal(BASE_SPEC)) + done(family.focal.id),
                null,
              ]
            : [
                call('read', { path: focalPath }),
                call('slack_read', {}),
                initial,
                writeSources(family.referenceFocal(BASE_SPEC)) + done(family.focal.id),
                call('linear_get_issue', { id: family.hotfix.id }) +
                  call('slack_search', { query: 'exporter v2' }),
                writeSources(family.referenceHotfix()) + done(family.hotfix.id),
                null,
              ];
    const requests: Array<Record<string, any>> = [];
    const server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      if (!req.url?.endsWith('/responses')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      const p = JSON.parse(body);
      requests.push(p);
      const n = requests.length,
        code = batches[n - 1];
      const output = code
        ? [
            {
              type: 'custom_tool_call',
              id: 'fc' + n,
              call_id: 'call' + n,
              name: 'exec',
              namespace: 'functions',
              input: code,
            },
          ]
        : [
            {
              type: 'message',
              id: 'msg' + n,
              role: 'assistant',
              content: [{ type: 'output_text', text: 'Finished.' }],
            },
          ];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      let sequence = 0;
      const send = (type: string, event: Record<string, unknown>) =>
        res.write(
          `event: ${type}\r\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...event })}\r\n\r\n`,
        );
      send('response.created', {
        response: { id: 'r' + n, model, status: 'in_progress', output: [] },
      });
      output.forEach((item, index) => {
        send('response.output_item.added', { output_index: index, item });
        if (item.type === 'message')
          send('response.output_text.delta', {
            item_id: item.id,
            output_index: index,
            content_index: 0,
            delta: 'Finished.',
          });
        send('response.output_item.done', { output_index: index, item });
      });
      send('response.completed', {
        response: {
          id: 'r' + n,
          model,
          status: 'completed',
          output,
          usage: {
            input_tokens: 100,
            output_tokens: 10,
            total_tokens: 110,
            input_tokens_details: { cached_tokens: 20 },
            output_tokens_details: { reasoning_tokens: 3 },
          },
        },
      });
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('Missing server address');
    vi.stubEnv('CODEX_TEST_UPSTREAM', `http://127.0.0.1:${address.port}`);
    try {
      const result = await run({
        runId: 'synthetic',
        resultsDir: root,
        condition: {
          family: 'settlement',
          scenario,
          load: 'high',
          noise: 'none',
          delivery: 'ambient',
          seed: 1,
        },
        modelConfig: { provider: 'openai-codex', model, thinking: 'default' },
        budgets: { ...DEFAULT_BUDGETS, timeoutMs: 60000, maxTotalTokens: budget },
        keepWorkspace: false,
      });
      expect(
        result.audit.eligible,
        JSON.stringify({
          termination: result.termination,
          failed: result.audit.checks.filter((c) => !c.passed),
          log: (await readFile(path.join(root, 'synthetic/codex.jsonl'), 'utf8')).slice(
            -4000,
          ),
        }),
      ).toBe(true);
      expect(result.runtime).toMatchObject({
        agent: 'codex',
        thinking: 'default',
        resolvedThinking: effort,
        maxOutputTokens: null,
      });
      expect(
        requests.every((r) => r.model === model && r.reasoning.effort === effort),
      ).toBe(true);
      expect(requests.every((r) => !('max_output_tokens' in r))).toBe(true);
      // One current indicator per provider input, even across repeated code-mode turns.
      expect(
        requests.every(
          (r) =>
            (JSON.stringify(r.input).match(/<environment_status>/g) ?? []).length === 1,
        ),
      ).toBe(true);
      expect(
        requests.every((r) => !JSON.stringify(r.input).includes('<skills_instructions>')),
      ).toBe(true);
      expect(
        requests.every((r) => JSON.stringify(r.input).includes('workspace-write')),
      ).toBe(true);
      expect(
        requests.every(
          (r) => !JSON.stringify(r.input).includes('sandbox_mode` is `read-only'),
        ),
      ).toBe(true);
      const raw = (await readFile(path.join(root, 'synthetic/codex.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(raw.filter((e) => e.type === 'model_request')).toHaveLength(requests.length);
      if (budget === 100) {
        expect(result.termination.reason).toBe('token_budget');
        expect(requests).toHaveLength(1);
        expect(result.usage.turnCalls).toBe(1);
        return;
      }
      expect(result.termination, JSON.stringify(result.termination)).toMatchObject({
        reason: 'agent_finished',
      });
      expect(requests).toHaveLength(batches.length);
      expect(result.usage).toMatchObject({
        turnCalls: batches.length,
        totalTokens: batches.length * 110,
        cacheRead: batches.length * 20,
        reasoning: batches.length * 3,
      });
      if (scenario !== 'updates') {
        const event = result.grade.events.at(-1)!;
        expect(result.grade.valid).toBe(true);
        expect(event.adapted, JSON.stringify(event)).toBe(true);
        if (scenario === 'urgency-downgrade')
          expect(event.timing).toMatchObject({
            eligible: true,
            targetChecksFailingAtFire: family.checkIds.hotfix.length - 1,
          });
        if (scenario === 'delayed-relevance')
          expect(event.delayed).toMatchObject({
            assignmentDecision: 4,
            contentBeforeAssignment: true,
            laterRetrievalDecision: 5,
          });
      }
    } finally {
      vi.unstubAllEnvs();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
  90000,
);
