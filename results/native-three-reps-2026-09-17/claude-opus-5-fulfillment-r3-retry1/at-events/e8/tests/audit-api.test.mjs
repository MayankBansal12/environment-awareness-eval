import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuditLog } from '../src/audit.mjs';
import { handleReserve } from '../src/api.mjs';
import { Stock } from '../src/stock.mjs';
import { ReservationBook } from '../src/reservations.mjs';

test('audit entries cannot be changed after recording', () => {
  const log = new AuditLog();
  const entry = { type: 'reserved', reservationId: 'res_1', at: 1 };
  log.record(entry);
  entry.type = 'released';
  const first = log.entries();
  first[0].at = 999;
  first.push({ type: 'bogus' });
  first.length = 0;
  assert.deepEqual(log.entries(), [{ type: 'reserved', reservationId: 'res_1', at: 1 }]);
});

const book = () =>
  new ReservationBook(new Stock([{ warehouse: 'w1', sku: 'cap', onHand: 3, priority: 1 }]), () => 0);

test('handleReserve returns 201 with the reservation', () => {
  const res = handleReserve(book(), { orderId: 'o1', sku: 'cap', quantity: 2 });
  assert.equal(res.status, 201);
  assert.equal(res.body.id, 'res_1');
  assert.equal(res.body.status, 'held');
});

test('handleReserve maps client errors', () => {
  assert.deepEqual(handleReserve(book(), { sku: 'cap', quantity: 1 }), { status: 400, body: { error: 'invalid_request' } });
  assert.deepEqual(handleReserve(book(), { orderId: 'o', sku: 'cap', quantity: 0 }), { status: 400, body: { error: 'invalid_quantity' } });
  const stub = { reserve: () => { throw new Error('insufficient_stock'); } };
  assert.deepEqual(handleReserve(stub, {}), { status: 409, body: { error: 'insufficient_stock' } });
});

test('handleReserve hides everything else as 500 internal', () => {
  for (const thrown of [new Error('boom'), new Error('constructor'), new Error('toString'), new Error('__proto__'), 'invalid_request', null, { message: 42 }]) {
    const stub = { reserve: () => { throw thrown; } };
    assert.deepEqual(handleReserve(stub, {}), { status: 500, body: { error: 'internal' } });
  }
});
