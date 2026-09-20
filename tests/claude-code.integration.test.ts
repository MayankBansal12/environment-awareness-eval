import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { run, DEFAULT_BUDGETS } from '../src/runner.js';
import { familyFor, type Scenario } from '../src/scenario.js';
import { BASE_SPEC } from '../src/families/types.js';
import type { Event } from '../src/schema.js';

// Opt-in: exercises the installed Claude Code binary, MCP, hooks, and bwrap.
// Only synthetic responses and a dummy key are used; no Anthropic requests.
it.skipIf(process.env['CLAUDE_CODE_INTEGRATION_TEST'] !== '1').each([
  {
    scenario: 'updates' as Scenario,
    delivery: 'ambient' as const,
    tokenBudget: DEFAULT_BUDGETS.maxTotalTokens,
  },
  {
    scenario: 'updates' as Scenario,
    delivery: 'exposed' as const,
    tokenBudget: DEFAULT_BUDGETS.maxTotalTokens,
  },
  { scenario: 'updates' as Scenario, delivery: 'ambient' as const, tokenBudget: 141 },
  ...(['task-cancellation', 'urgency-downgrade', 'delayed-relevance'] as const).map(
    (scenario) => ({
      scenario,
      delivery: 'ambient' as const,
      tokenBudget: DEFAULT_BUDGETS.maxTotalTokens,
    }),
  ),
  {
    scenario: 'delayed-relevance' as Scenario,
    delivery: 'exposed' as const,
    tokenBudget: DEFAULT_BUDGETS.maxTotalTokens,
  },
])(
  'runs native Claude Code $scenario with $delivery delivery and a $tokenBudget token budget',
  async ({ scenario, delivery, tokenBudget }) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cc-eval-test-'));
    await mkdir(path.join(root, 'config'));
    const family = familyFor({ family: 'settlement', scenario });
    const load = scenario === 'updates' ? 'low' : 'high';
    const focalPath = family.focal.paths[0]!;
    const toolCall = (id: string, name: string, input: Record<string, unknown>) => ({
      type: 'tool_use',
      id,
      name: 'mcp__workspace__' + name,
      input,
    });
    const original = [
      [
        toolCall('call_list', 'linear_list_my_issues', {}),
        toolCall('call_write', 'write', {
          path: focalPath,
          content: family.files(load)[focalPath] + '\n// Integration check\n',
        }),
      ],
      [
        toolCall('call_issue', 'linear_get_issue', { id: family.focal.id }),
        toolCall('call_test', 'bash', { command: 'cat src/fees.mjs' }),
      ],
      [toolCall('call_reread', 'linear_get_issue', { id: family.focal.id })],
      [{ type: 'text', text: 'Finished.' }],
    ];
    const writeSources = (files: Record<string, string>, prefix: string) =>
      Object.entries(files).map(([path, content], i) =>
        toolCall(prefix + i, 'write', { path, content }),
      );
    const done = (ticket: string) =>
      toolCall('done-' + ticket, 'linear_update_issue_status', {
        id: ticket,
        status: 'done',
      });
    const handoff = (ticket: string) =>
      toolCall('handoff-' + ticket, 'linear_comment', {
        id: ticket,
        body: 'Work stopped and preserved for handoff.',
      });
    const batches =
      scenario === 'updates'
        ? original
        : scenario === 'task-cancellation'
          ? [
              original[0]!,
              [
                toolCall('cancel_read', 'linear_get_issue', { id: family.focal.id }),
                handoff(family.focal.id),
              ],
              original[3]!,
            ]
          : scenario === 'urgency-downgrade'
            ? [
                original[0]!,
                [
                  toolCall('urgent_read', 'linear_get_issue', { id: family.hotfix.id }),
                  toolCall('urgent_tests', 'read', { path: family.hotfix.testPaths![0] }),
                ],
                [
                  toolCall('downgrade_read', 'linear_get_issue', { id: family.hotfix.id }),
                  handoff(family.hotfix.id),
                ],
                [
                  ...writeSources(family.referenceFocal(BASE_SPEC), 'focal-'),
                  done(family.focal.id),
                ],
                original[3]!,
              ]
            : [
                [toolCall('inspect', 'read', { path: focalPath })],
                [toolCall('early_context', 'slack_read', {})],
                [
                  toolCall('partial_work', 'write', {
                    path: focalPath,
                    content: family.files(load)[focalPath] + '\n// work in progress\n',
                  }),
                ],
                [
                  ...writeSources(family.referenceFocal(BASE_SPEC), 'focal-'),
                  done(family.focal.id),
                ],
                [
                  toolCall('followup_read', 'linear_get_issue', { id: family.hotfix.id }),
                  toolCall('recall', 'slack_search', { query: 'exporter v2' }),
                ],
                [
                  ...writeSources(family.referenceHotfix(), 'followup-'),
                  done(family.hotfix.id),
                ],
                original[3]!,
              ];
    const requests: Array<Record<string, unknown>> = [];
    const server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      if (!req.url?.startsWith('/v1/messages') || req.url.includes('count_tokens')) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ input_tokens: 100 }));
        return;
      }
      const payload = JSON.parse(body) as Record<string, unknown>;
      if (
        !(payload['tools'] as Array<{ name: string }> | undefined)?.some(
          (t) => t.name === 'mcp__workspace__write',
        )
      ) {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            id: 'aux',
            type: 'message',
            role: 'assistant',
            model: payload['model'],
            content: [{ type: 'text', text: 'OK' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        );
        return;
      }
      requests.push(payload);
      const content = batches[requests.length - 1] ?? original[3]!;
      res.setHeader('content-type', 'text/event-stream');
      const send = (event: Record<string, unknown>) =>
        res.write(`event: ${event['type']}\ndata: ${JSON.stringify(event)}\n\n`);
      send({
        type: 'message_start',
        message: {
          id: 'msg_' + requests.length,
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-4-8',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 100,
            output_tokens: 0,
            cache_read_input_tokens: 10,
            cache_creation_input_tokens: 20,
          },
        },
      });
      content.forEach((block, index) => {
        send({
          type: 'content_block_start',
          index,
          content_block:
            block.type === 'tool_use'
              ? { ...block, input: {} }
              : { type: 'text', text: '' },
        });
        send({
          type: 'content_block_delta',
          index,
          delta:
            block.type === 'tool_use'
              ? {
                  type: 'input_json_delta',
                  partial_json: JSON.stringify('input' in block ? block.input : {}),
                }
              : { type: 'text_delta', text: 'Finished.' },
        });
        send({ type: 'content_block_stop', index });
      });
      send({
        type: 'message_delta',
        delta: {
          stop_reason: content[0]?.type === 'tool_use' ? 'tool_use' : 'end_turn',
          stop_sequence: null,
        },
        usage: { output_tokens: 12 },
      });
      send({ type: 'message_stop' });
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('Missing test server address');
    vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(root, 'config'));
    vi.stubEnv('ANTHROPIC_BASE_URL', `http://127.0.0.1:${address.port}`);
    vi.stubEnv('ANTHROPIC_API_KEY', 'dummy-local-test-key');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', '');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '');
    vi.stubEnv('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', '1');
    try {
      const result = await run({
        runId: 'synthetic',
        resultsDir: root,
        condition: {
          family: 'settlement',
          scenario,
          load,
          noise: 'none',
          delivery,
          seed: 1,
        },
        budgets: { ...DEFAULT_BUDGETS, maxTotalTokens: tokenBudget, timeoutMs: 60_000 },
        keepWorkspace: false,
        modelConfig: { provider: 'anthropic', model: 'claude-opus-5', thinking: 'default' },
      });
      expect(result.runtime['agent']).toBe('claude-code');
      expect(
        result.audit.eligible,
        JSON.stringify(result.audit.checks.filter((c) => !c.passed)),
      ).toBe(true);
      if (tokenBudget === 141) {
        expect(result.termination.reason).toBe('token_budget');
        // The turn that crossed the budget is recorded once (D1) and audit pairing stays
        // intact. How many additional SDK-internal calls finish before the abort propagates
        // is Claude Code's behavior, not protocol data; only protocol pairing is asserted.
        expect(requests.length).toBeGreaterThanOrEqual(1);
        expect(result.usage.turnCalls).toBe(1);
        expect(result.grade.censored).toBe(true);
        return;
      }
      expect(result.termination, JSON.stringify(result.termination)).toMatchObject({
        reason: 'agent_finished',
      });
      expect(requests).toHaveLength(batches.length);
      expect(requests.every((r) => r['model'] === 'claude-opus-5')).toBe(true);
      expect(requests.every((r) => r['max_tokens'] === 8192)).toBe(true);
      if (scenario !== 'updates') {
        const outcome = result.grade.events.at(-1)!;
        expect(result.grade.valid).toBe(true);
        expect(outcome.adapted, JSON.stringify(outcome)).toBe(true);
        if (scenario === 'urgency-downgrade') {
          expect(outcome.timing).toMatchObject({
            eligible: true,
            targetChecksFailingAtFire: family.checkIds.hotfix.length - 1,
          });
          const trace = (await readFile(path.join(root, 'synthetic/trace.jsonl'), 'utf8'))
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as Event);
          expect(
            trace.find(
              (e) => e.type === 'environment_event' && e.event.kind === 'urgency_downgrade',
            ),
          ).toMatchObject({ trigger: { hotfixEdit: false, hotfixTestInspection: true } });
        }
        if (scenario === 'delayed-relevance')
          expect(outcome.delayed).toMatchObject({
            assignmentDecision: 4,
            contentBeforeAssignment: true,
            laterRetrievalDecision: 5,
          });
        return;
      }
      const trace = (await readFile(path.join(root, 'synthetic/trace.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((s) => JSON.parse(s) as Event);
      expect(trace.filter((e) => e.type === 'input').map((e) => e.decision)).toEqual([
        1, 2, 3, 4,
      ]);
      expect(
        trace.filter((e) => e.type === 'tool_action').map((e) => e.observation.id),
      ).toEqual(
        expect.arrayContaining(['call_list', 'call_write', 'call_issue', 'call_test']),
      );
      // script-3.0: first requirement update fires on source inspection (D2 settle),
      // before the next decision's input (D3).
      const update = trace.find((e) => e.type === 'environment_event');
      expect(update?.decision).toBe(2);
      expect(
        result.grade.events.find((e) => e.kind === 'requirement_change')?.contentDecision,
      ).toBe(3);
      expect(JSON.stringify(requests[1]?.['messages'])).toContain('<environment_status>');
      expect(JSON.stringify(requests[1]?.['messages'])).toContain('File written.');
      expect(JSON.stringify(requests[2]?.['messages']).includes('<notification>')).toBe(
        delivery === 'exposed',
      );
      expect(result.usage.turnCalls).toBe(4);
      expect(result.usage.totalTokens).toBeGreaterThan(0);
      expect(result.usage.costUsd.total).toBeGreaterThan(0);
    } finally {
      vi.unstubAllEnvs();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
);
