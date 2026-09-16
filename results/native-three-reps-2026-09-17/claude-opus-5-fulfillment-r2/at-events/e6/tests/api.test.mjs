import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleReserve } from '../src/api.mjs';
import { Stock } from '../src/stock.mjs';
import { ReservationBook } from '../src/reservations.mjs';

const book = () => new ReservationBook(new Stock([{ warehouse: 'w1', sku: 'cap', onHand: 2, priority: 1 }]), () => 0);
const throwing = (message) => ({ reserve: () => { throw new Error(message); } });

test('201 with the reservation', () => {
  const res = handleReserve(book(), { orderId: 'o1', sku: 'cap', quantity: 1 });
  assert.equal(res.status, 201);
  assert.equal(res.body.id, 'res_1');
  assert.equal(res.body.status, 'held');
});

test('maps client errors', () => {
  assert.deepEqual(handleReserve(book(), { sku: 'cap', quantity: 1 }), { status: 400, body: { error: 'invalid_request' } });
  assert.deepEqual(handleReserve(book(), null), { status: 400, body: { error: 'invalid_request' } });
  assert.deepEqual(handleReserve(book(), { orderId: 'o', sku: 'cap', quantity: 1.5 }), { status: 400, body: { error: 'invalid_quantity' } });
  assert.deepEqual(handleReserve(throwing('insufficient_stock'), {}), { status: 409, body: { error: 'insufficient_stock' } });
});

test('everything else is a 500 internal, including prototype key names', () => {
  for (const message of ['boom', 'constructor', 'toString', '__proto__', 'hasOwnProperty'])
    assert.deepEqual(handleReserve(throwing(message), {}), { status: 500, body: { error: 'internal' } });
  assert.deepEqual(handleReserve({ reserve: () => { throw undefined; } }, {}), { status: 500, body: { error: 'internal' } });
});
