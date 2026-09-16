import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Stock } from '../src/stock.mjs';
import { allocate } from '../src/allocation.mjs';
import { AuditLog } from '../src/audit.mjs';
import { ReservationBook } from '../src/reservations.mjs';
import { handleReserve } from '../src/api.mjs';

test('Stock copies levels', () => {
  const input = [{ warehouse: 'w1', sku: 'cap', onHand: 5, priority: 1 }];
  const stock = new Stock(input);
  stock.level('cap', 'w1').onHand = 0;
  assert.equal(input[0].onHand, 5);
  assert.equal(stock.level('cap', 'w1').held, 0);
});

test('allocate uses available quantity, never below zero', () => {
  const result = allocate(
    [
      { warehouse: 'a', sku: 'x', onHand: 5, held: 7, priority: 1 },
      { warehouse: 'b', sku: 'x', onHand: 5, held: 2, priority: 2 },
    ],
    5,
  );
  assert.deepEqual(result, { lines: [{ warehouse: 'b', quantity: 3 }], backorderQuantity: 2 });
});

test('allocate breaks priority ties by warehouse id ascending', () => {
  const levels = [
    { warehouse: 'w3', sku: 'x', onHand: 2, held: 0, priority: 1 },
    { warehouse: 'w1', sku: 'x', onHand: 2, held: 0, priority: 1 },
    { warehouse: 'w2', sku: 'x', onHand: 2, held: 0, priority: 0 },
  ];
  assert.deepEqual(allocate(levels, 5).lines, [
    { warehouse: 'w2', quantity: 2 },
    { warehouse: 'w1', quantity: 2 },
    { warehouse: 'w3', quantity: 1 },
  ]);
  assert.equal(levels[0].warehouse, 'w3');
});

test('audit log stores and returns copies', () => {
  const log = new AuditLog();
  const entry = { type: 'reserved', reservationId: 'res_1', at: 0 };
  log.record(entry);
  entry.type = 'committed';
  const read = log.entries();
  read[0].at = 99;
  read.push({ type: 'expired', reservationId: 'res_2', at: 1 });
  assert.deepEqual(log.entries(), [{ type: 'reserved', reservationId: 'res_1', at: 0 }]);
});

const book = () =>
  new ReservationBook(new Stock([{ warehouse: 'w1', sku: 'cap', onHand: 3, priority: 1 }]), () => 0);

test('handleReserve maps results and errors', () => {
  const ok = handleReserve(book(), { orderId: 'o1', sku: 'cap', quantity: 2 });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.id, 'res_1');
  assert.deepEqual(handleReserve(book(), { orderId: '', sku: 'cap', quantity: 1 }), {
    status: 400,
    body: { error: 'invalid_request' },
  });
  assert.deepEqual(handleReserve(book(), { orderId: 'o', sku: 'cap', quantity: 0 }), {
    status: 400,
    body: { error: 'invalid_quantity' },
  });
  const throwing = (error) => ({ reserve: () => { throw error; } });
  assert.deepEqual(handleReserve(throwing(new Error('insufficient_stock')), {}), {
    status: 409,
    body: { error: 'insufficient_stock' },
  });
  for (const error of [new Error('boom'), new Error('constructor'), new Error('toString'), null, 'invalid_request'])
    assert.deepEqual(handleReserve(throwing(error), {}), { status: 500, body: { error: 'internal' } });
});
