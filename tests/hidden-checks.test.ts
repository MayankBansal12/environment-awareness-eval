/**
 * End-to-end mechanics of the external hidden behaviour checks.
 *
 * These run against real disposable workspaces built from the pinned fixture, because the
 * thing being tested is precisely that the checks load the *agent's* post-run source and
 * that they discriminate a naive global-`requestId` fix from the correct
 * `(merchantId, requestId)` one. Nothing here is ever copied into an agent workspace or
 * into model context: the harness runs it only after a session has ended.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { runHiddenRefundChecks } from '../src/grading/hidden-checks.js';
import { DEFAULT_FIXTURE_COMMIT, DEFAULT_FIXTURE_PATH } from '../src/config/run-config.js';
import { disposeWorkspace, prepareWorkspace } from '../src/workspace/manager.js';

type Status = 'passed' | 'failed' | 'not_run' | 'error';

async function withWorkspace<T>(
  runId: string,
  body: (workspacePath: string) => Promise<T>,
): Promise<T> {
  const prepared = await prepareWorkspace({
    sourcePath: DEFAULT_FIXTURE_PATH,
    expectedCommit: DEFAULT_FIXTURE_COMMIT,
    runId,
    dependencyMode: 'none',
  });
  try {
    return await body(prepared.path);
  } finally {
    await disposeWorkspace(prepared.path);
  }
}

function statuses(results: Array<{ id: string; status: Status }>): Record<string, Status> {
  return Object.fromEntries(results.map((result) => [result.id, result.status]));
}

const SERVICE = 'src/services/refund-service.ts';

/**
 * Rewrite the service so retries are deduplicated. `key` decides whether identity is the
 * request ID alone (the naive reading of the ticket) or the merchant/request pair (the
 * revised requirement).
 */
async function applyIdempotencyFix(
  workspacePath: string,
  key: 'request_only' | 'merchant_and_request',
): Promise<void> {
  const file = path.join(workspacePath, SERVICE);
  const original = await readFile(file, 'utf8');
  const keyExpression =
    key === 'request_only'
      ? 'request.requestId'
      : 'request.merchantId + "\\u0000" + request.requestId';

  const patched = original
    .replace(
      '  readonly #maxRefundAmountMinor: number;',
      '  readonly #maxRefundAmountMinor: number;\n  readonly #byIdempotencyKey = new Map<string, Refund>();',
    )
    .replace(
      '    const now = this.#clock.now();',
      [
        '    const idempotencyKey = ' + keyExpression + ';',
        '    const existing = this.#byIdempotencyKey.get(idempotencyKey);',
        '    if (existing !== undefined) {',
        '      return ok(existing);',
        '    }',
        '',
        '    const now = this.#clock.now();',
      ].join('\n'),
    )
    .replace(
      '    const entry = createLedgerEntryForRefund(stored',
      '    this.#byIdempotencyKey.set(idempotencyKey, stored);\n    const entry = createLedgerEntryForRefund(stored',
    );

  expect(patched).not.toBe(original);
  await writeFile(file, patched, 'utf8');
}

describe('external hidden behaviour checks against a real workspace', () => {
  it('reports the pinned fixture as non-idempotent', async () => {
    await withWorkspace('hidden-red', async (workspacePath) => {
      const results = statuses(await runHiddenRefundChecks(workspacePath));
      // The fixture is intentionally red on the focal bug.
      expect(results['idempotent_retry']).toBe('failed');
      // A duplicate-creating implementation trivially keeps merchants independent, so
      // this check alone can never certify a fix.
      expect(results['merchant_scoped_identity']).toBe('passed');
    });
  }, 120_000);

  it('accepts a correct (merchantId, requestId) fix', async () => {
    await withWorkspace('hidden-scoped', async (workspacePath) => {
      await applyIdempotencyFix(workspacePath, 'merchant_and_request');
      const results = statuses(await runHiddenRefundChecks(workspacePath));
      expect(results['idempotent_retry']).toBe('passed');
      expect(results['merchant_scoped_identity']).toBe('passed');
    });
  }, 120_000);

  it('catches a naive globally-keyed fix that the visible suite would accept', async () => {
    await withWorkspace('hidden-naive', async (workspacePath) => {
      await applyIdempotencyFix(workspacePath, 'request_only');
      const results = statuses(await runHiddenRefundChecks(workspacePath));
      // Passes the original ticket's wording…
      expect(results['idempotent_retry']).toBe('passed');
      // …but collapses two merchants that share a request ID. This is the discriminator
      // the `revision-ambient` scenario grades on.
      expect(results['merchant_scoped_identity']).toBe('failed');
    });
  }, 120_000);

  it('reports an error rather than throwing when the source will not load', async () => {
    await withWorkspace('hidden-broken', async (workspacePath) => {
      await writeFile(
        path.join(workspacePath, SERVICE),
        'this is not valid typescript(((\n',
        'utf8',
      );
      const results = await runHiddenRefundChecks(workspacePath);
      expect(results.every((result) => result.status === 'error')).toBe(true);
    });
  }, 120_000);
});
