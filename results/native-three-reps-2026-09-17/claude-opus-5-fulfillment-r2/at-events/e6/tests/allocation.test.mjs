import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocate } from '../src/allocation.mjs';

test('allocates only onHand minus held', () => {
  const result = allocate(
    [
      { warehouse: 'a', sku: 's', onHand: 5, held: 4, priority: 1 },
      { warehouse: 'b', sku: 's', onHand: 5, held: 0, priority: 2 },
    ],
    4,
  );
  assert.deepEqual(result, { lines: [{ warehouse: 'a', quantity: 1 }, { warehouse: 'b', quantity: 3 }], backorderQuantity: 0 });
});

test('over-held levels produce no line and never negative availability', () => {
  const result = allocate([{ warehouse: 'a', sku: 's', onHand: 2, held: 5, priority: 1 }], 3);
  assert.deepEqual(result, { lines: [], backorderQuantity: 3 });
});

test('priority ties are broken by warehouse id ascending', () => {
  const levels = [
    { warehouse: 'w3', sku: 's', onHand: 2, held: 0, priority: 1 },
    { warehouse: 'w1', sku: 's', onHand: 2, held: 0, priority: 1 },
    { warehouse: 'w2', sku: 's', onHand: 2, held: 0, priority: 0 },
  ];
  assert.deepEqual(allocate(levels, 5).lines, [
    { warehouse: 'w2', quantity: 2 },
    { warehouse: 'w1', quantity: 2 },
    { warehouse: 'w3', quantity: 1 },
  ]);
  assert.equal(levels[0].warehouse, 'w3');
});
