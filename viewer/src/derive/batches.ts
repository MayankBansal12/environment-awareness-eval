/**
 * Parallel tool batches.
 *
 * Pi may issue several tool calls in one assistant message and run them concurrently.
 * Siblings sharing a `batchId` are not a sequence and must never read as one — the order
 * they settled in is a race, and the harness deliberately exposes nothing mid-batch.
 * Every action in the corpus carries a `batchId` (`turn-<n>`), so a batch of one is the
 * common case and is not bracketed.
 */

import type { ActionRow } from './model.js';

export interface ActionBatch {
  batchId: string | null;
  decisionIndex: number;
  actions: ActionRow[];
  /** True when the batch holds more than one call, i.e. it really was parallel. */
  isParallel: boolean;
}

/**
 * A batch key is scoped to its decision, never the bare `batchId`.
 *
 * A batch is the tool calls issued by one assistant message, so it cannot span decisions
 * by definition. Counting on `batchId` alone trusted the id to be unique within a run,
 * which it was not: the harness named batches after the runtime's turn index, and that
 * index restarts at 0 when a provider error restarts the session. Traces written before
 * that fix carry `turn-0` several times over, and counting them together rendered calls
 * minutes apart as one parallel batch. Scoping by decision is correct for every trace and
 * repairs the old ones on read.
 */
export function batchKey(action: {
  batchId?: string | undefined;
  decisionIndex: number;
}): string | null {
  return action.batchId === undefined ? null : `${action.decisionIndex}|${action.batchId}`;
}

/** Counts members per batch, so a row can tell whether it had siblings. */
export function batchSizes(
  actions: ReadonlyArray<{ batchId?: string | undefined; decisionIndex: number }>,
): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const action of actions) {
    const key = batchKey(action);
    if (key === null) continue;
    sizes.set(key, (sizes.get(key) ?? 0) + 1);
  }
  return sizes;
}

/**
 * Groups consecutive actions that share a `batchId`, preserving order and sorting
 * siblings by `siblingOrdinal` (assistant source order) rather than settle order.
 * Actions without a `batchId` each form their own group.
 */
export function groupIntoBatches(actions: readonly ActionRow[]): ActionBatch[] {
  const batches: ActionBatch[] = [];
  for (const action of actions) {
    const last = batches[batches.length - 1];
    if (
      last !== undefined &&
      action.batchId !== null &&
      last.batchId === action.batchId
    ) {
      last.actions.push(action);
      last.isParallel = last.actions.length > 1;
      continue;
    }
    batches.push({
      batchId: action.batchId,
      decisionIndex: action.decisionIndex,
      actions: [action],
      isParallel: false,
    });
  }
  for (const batch of batches) {
    batch.actions.sort((a, b) => {
      const left = a.siblingOrdinal ?? a.actionIndex;
      const right = b.siblingOrdinal ?? b.actionIndex;
      if (left !== right) return left - right;
      return a.actionIndex - b.actionIndex;
    });
  }
  return batches;
}
