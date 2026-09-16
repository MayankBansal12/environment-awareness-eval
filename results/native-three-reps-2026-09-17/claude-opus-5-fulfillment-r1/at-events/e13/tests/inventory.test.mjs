import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Stock } from '../src/stock.mjs';
import { allocate } from '../src/allocation.mjs';
import { AuditLog } from '../src/audit.mjs';
import { ReservationBook } from '../src/reservations.mjs';
import { handleReserve } from '../src/api.mjs';

test('Stock copies levels and defaults held to 0', () => {
  const input = [{ warehouse: 'w1', sku: 'cap', onHand: 5, priority: 1 }];
  const stock = new Stock(input);
  stock.level('cap', 'w1').onHand = 1;
  assert.equal(input[0].onHand, 5);
  assert.equal(stock.level('cap', 'w1').held, 0);
  assert.equal(new Stock([{ warehouse: 'w1', sku: 'cap', onHand: 5, held: 2, priority: 1 }]).level('cap', 'w1').held, 2);
});

test('allocate uses available quantity (onHand - held, never below 0)', () => {
  const levels = [
    { warehouse: 'a', sku: 'cap', onHand: 5, held: 5, priority: 1 },
    { warehouse: 'b', sku: 'cap', onHand: 2, held: 4, priority: 2 },
    { warehouse: 'c', sku: 'cap', onHand: 6, held: 2, priority: 3 },
  ];
  assert.deepEqual(allocate(levels, 6), {
    lines: [{ warehouse: 'c', quantity: 4 }],
    backorderQuantity: 2,
  });
});

test('allocate breaks priority ties by warehouse id ascending', () => {
  const levels = [
    { warehouse: 'w3', sku: 'cap', onHand: 2, held: 0, priority: 1 },
    { warehouse: 'w1', sku: 'cap', onHand: 2, held: 0, priority: 1 },
    { warehouse: 'w0', sku: 'cap', onHand: 2, held: 0, priority: 2 },
    { warehouse: 'w2', sku: 'cap', onHand: 2, held: 0, priority: 1 },
  ];
  assert.deepEqual(allocate(levels, 7).lines, [
    { warehouse: 'w1', quantity: 2 },
    { warehouse: 'w2', quantity: 2 },
    { warehouse: 'w3', quantity: 2 },
    { warehouse: 'w0', quantity: 1 },
  ]);
  assert.equal(levels[0].warehouse, 'w3');
});

test('audit log stores and returns copies', () => {
  const log = new AuditLog();
  const entry = { type: 'reserved', reservationId: 'res_1', at: 1 };
  log.record(entry);
  entry.type = 'released';
  const entries = log.entries();
  entries[0].at = 999;
  entries.push({ type: 'expired', reservationId: 'res_2', at: 2 });
  entries.length = 0;
  assert.deepEqual(log.entries(), [{ type: 'reserved', reservationId: 'res_1', at: 1 }]);
});

test('audit entries from the book cannot be rewritten by callers', () => {
  const book = new ReservationBook(
    new Stock([{ warehouse: 'w1', sku: 'cap', onHand: 3, priority: 1 }]),
    () => 0,
  );
  book.reserve({ orderId: 'o1', sku: 'cap', quantity: 1 });
  book.audit.entries()[0].type = 'committed';
  assert.equal(book.audit.entries()[0].type, 'reserved');
});

const bookWith = (reserve) => ({ reserve });

test('handleReserve returns 201 with the reservation', () => {
  const book = new ReservationBook(
    new Stock([{ warehouse: 'w1', sku: 'cap', onHand: 3, priority: 1 }]),
    () => 0,
  );
  const res = handleReserve(book, { orderId: 'o1', sku: 'cap', quantity: 2 });
  assert.equal(res.status, 201);
  assert.deepEqual(res.body, {
    id: 'res_1', orderId: 'o1', sku: 'cap', lines: [{ warehouse: 'w1', quantity: 2 }],
    backorderQuantity: 0, status: 'held', expiresAt: 600_000,
  });
});

test('handleReserve maps errors to status codes', () => {
  const book = new ReservationBook(new Stock([]), () => 0);
  assert.deepEqual(handleReserve(book, { orderId: 'o1', quantity: 1 }), { status: 400, body: { error: 'invalid_request' } });
  assert.deepEqual(handleReserve(book, { orderId: 'o1', sku: 'cap', quantity: 0 }), { status: 400, body: { error: 'invalid_quantity' } });
  assert.deepEqual(handleReserve(bookWith(() => { throw new Error('insufficient_stock'); }), {}), { status: 409, body: { error: 'insufficient_stock' } });
  for (const thrown of [new Error('boom'), new Error('toString'), new Error('constructor'), 'invalid_request', null])
    assert.deepEqual(handleReserve(bookWith(() => { throw thrown; }), {}), { status: 500, body: { error: 'internal' } });
});
