import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocate } from '../src/allocation.mjs';
import { Stock } from '../src/stock.mjs';

test('allocation uses onHand - held, never below zero', () => {
  const levels = [
    { warehouse: 'a', sku: 's', onHand: 5, held: 5, priority: 1 },
    { warehouse: 'b', sku: 's', onHand: 2, held: 4, priority: 2 },
    { warehouse: 'c', sku: 's', onHand: 4, held: 1, priority: 3 },
  ];
  assert.deepEqual(allocate(levels, 5), {
    lines: [{ warehouse: 'c', quantity: 3 }],
    backorderQuantity: 2,
  });
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

test('Stock copies levels and defaults held to 0', () => {
  const input = [{ warehouse: 'w1', sku: 's', onHand: 3, priority: 1 }];
  const stock = new Stock(input);
  stock.level('s', 'w1').held = 2;
  assert.equal(input[0].held, undefined);
  assert.equal(stock.level('s', 'w1').held, 2);
  assert.equal(new Stock([{ warehouse: 'w1', sku: 's', onHand: 3, held: 1, priority: 1 }]).level('s', 'w1').held, 1);
});
