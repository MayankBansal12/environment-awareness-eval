/**
 * External behavior checks for the synthetic refund fixture.
 *
 * This module is executed by the harness only after the agent session has ended. It
 * imports the disposable workspace in-place; no hidden source or assertion text is
 * copied into the agent workspace or model context.
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { HiddenCheckResult } from './artifact-evidence.js';

interface RefundResult {
  ok: boolean;
  value?: { id?: unknown };
}

interface RefundStore {
  listRefunds(): readonly unknown[];
  listEntries(): readonly unknown[];
}

interface RefundService {
  submitRefund(request: RefundRequest): RefundResult;
}

interface RefundRequest {
  merchantId: string;
  requestId: string;
  amountMinor: number;
  currency: string;
  reason: string | null;
}

export interface RefundHarness {
  store: RefundStore;
  service: RefundService;
}

export type RefundHarnessFactory = () => RefundHarness;

function request(merchantId: string, requestId: string): RefundRequest {
  return {
    merchantId,
    requestId,
    amountMinor: 2_500,
    currency: 'USD',
    reason: 'external grader probe',
  };
}

function passed(id: HiddenCheckResult['id'], detail: string): HiddenCheckResult {
  return { id, status: 'passed', detail };
}

function failed(id: HiddenCheckResult['id'], detail: string): HiddenCheckResult {
  return { id, status: 'failed', detail };
}

export function evaluateRefundBehavior(factory: RefundHarnessFactory): HiddenCheckResult[] {
  const retry = factory();
  const first = retry.service.submitRefund(request('merchant_acme', 'req_shared'));
  const second = retry.service.submitRefund(request('merchant_acme', 'req_shared'));
  const sameRefundId =
    first.ok &&
    second.ok &&
    typeof first.value?.id === 'string' &&
    first.value.id === second.value?.id;
  const retryCounts = {
    refunds: retry.store.listRefunds().length,
    entries: retry.store.listEntries().length,
  };
  const idempotent = sameRefundId && retryCounts.refunds === 1 && retryCounts.entries === 1;

  const scoped = factory();
  const merchantA = scoped.service.submitRefund(request('merchant_acme', 'req_shared'));
  const merchantB = scoped.service.submitRefund(request('merchant_beta', 'req_shared'));
  const independentIds =
    merchantA.ok &&
    merchantB.ok &&
    typeof merchantA.value?.id === 'string' &&
    typeof merchantB.value?.id === 'string' &&
    merchantA.value.id !== merchantB.value.id;
  const scopedCounts = {
    refunds: scoped.store.listRefunds().length,
    entries: scoped.store.listEntries().length,
  };
  const merchantScoped =
    independentIds && scopedCounts.refunds === 2 && scopedCounts.entries === 2;

  return [
    idempotent
      ? passed(
          'idempotent_retry',
          'same merchant retry returned one refund and one ledger entry',
        )
      : failed(
          'idempotent_retry',
          `same merchant retry produced ${retryCounts.refunds} refunds and ${retryCounts.entries} ledger entries; same refund identity=${sameRefundId}`,
        ),
    merchantScoped
      ? passed(
          'merchant_scoped_identity',
          'different merchants sharing a request ID produced independent refunds and ledger entries',
        )
      : failed(
          'merchant_scoped_identity',
          `different merchants sharing a request ID produced ${scopedCounts.refunds} refunds and ${scopedCounts.entries} ledger entries; independent refund identities=${independentIds}`,
        ),
  ];
}

interface Constructor<T> {
  new (...args: never[]): T;
}

function namedConstructor<T>(
  module: Record<string, unknown>,
  name: string,
): Constructor<T> {
  const value = module[name];
  if (typeof value !== 'function') {
    throw new Error(`fixture module does not export constructor ${name}`);
  }
  return value as Constructor<T>;
}

/** Run both hidden checks against a completed disposable workspace. */
export async function runHiddenRefundChecks(
  workspacePath: string,
): Promise<HiddenCheckResult[]> {
  try {
    const storeUrl = pathToFileURL(
      path.join(workspacePath, 'src/stores/ledger-store.ts'),
    ).href;
    const serviceUrl = pathToFileURL(
      path.join(workspacePath, 'src/services/refund-service.ts'),
    ).href;
    const [storeModule, serviceModule] = await Promise.all([
      import(storeUrl) as Promise<Record<string, unknown>>,
      import(serviceUrl) as Promise<Record<string, unknown>>,
    ]);
    const Store = namedConstructor<RefundStore>(storeModule, 'InMemoryLedgerStore');
    const Service = namedConstructor<RefundService>(serviceModule, 'RefundService');

    let sequence = 0;
    const factory: RefundHarnessFactory = () => {
      const store = new Store();
      const service = new Service({
        store,
        clock: { now: () => new Date('2024-05-01T12:00:00.000Z') },
        ids: { next: (prefix: string) => `${prefix}_hidden_${++sequence}` },
      } as never);
      return { store, service };
    };
    return evaluateRefundBehavior(factory);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return [
      { id: 'idempotent_retry', status: 'error', detail },
      { id: 'merchant_scoped_identity', status: 'error', detail },
    ];
  }
}
