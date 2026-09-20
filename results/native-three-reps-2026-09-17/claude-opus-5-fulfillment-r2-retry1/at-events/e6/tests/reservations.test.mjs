import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Stock } from '../src/stock.mjs';
import { ReservationBook } from '../src/reservations.mjs';

const MIN = 60_000;
const setup = () => {
  let now = 0;
  const clock = { set: (t) => (now = t) };
  const stock = new Stock([
    { warehouse: 'w1', sku: 'cap', onHand: 6, priority: 1 },
    { warehouse: 'w2', sku: 'cap', onHand: 4, priority: 2 },
  ]);
  return { clock, stock, book: new ReservationBook(stock, () => now) };
};

test('a hold expires exactly at expiresAt', () => {
  const { clock, book } = setup();
  book.reserve({ orderId: 'o1', sku: 'cap', quantity: 2 });
  clock.set(10 * MIN);
  assert.equal(book.available('cap'), 10);
});

test('releasing twice only releases once', () => {
  const { book } = setup();
  const hold = book.reserve({ orderId: 'o1', sku: 'cap', quantity: 3 });
  book.release(hold.id);
  book.release(hold.id);
  assert.equal(book.available('cap'), 10);
});

test('allocation skips quantity already held', () => {
  const { book } = setup();
  book.reserve({ orderId: 'o1', sku: 'cap', quantity: 5 });
  const second = book.reserve({ orderId: 'o2', sku: 'cap', quantity: 3 });
  assert.deepEqual(second.lines, [
    { warehouse: 'w1', quantity: 1 },
    { warehouse: 'w2', quantity: 2 },
  ]);
});

test('quantities must be positive integers', () => {
  const { book } = setup();
  for (const quantity of [0, -1, 1.5])
    assert.throws(() => book.reserve({ orderId: 'o1', sku: 'cap', quantity }), /invalid_quantity/);
});

test('VIP holds last 30 minutes; other tiers and missing tier last 10', () => {
  const { clock, book } = setup();
  const vip = book.reserve({ orderId: 'o1', sku: 'cap', quantity: 1, customerTier: 'vip' });
  const std = book.reserve({ orderId: 'o2', sku: 'cap', quantity: 1, customerTier: 'standard' });
  const none = book.reserve({ orderId: 'o3', sku: 'cap', quantity: 1 });
  assert.equal(vip.expiresAt, 30 * MIN);
  assert.equal(std.expiresAt, 10 * MIN);
  assert.equal(none.expiresAt, 10 * MIN);
  clock.set(10 * MIN);
  assert.equal(book.available('cap'), 9);
  clock.set(30 * MIN - 1);
  assert.equal(book.available('cap'), 9);
  clock.set(30 * MIN);
  assert.equal(book.available('cap'), 10);
});

test('releasing a committed reservation does not touch held', () => {
  const { stock, book } = setup();
  const a = book.reserve({ orderId: 'o1', sku: 'cap', quantity: 2 });
  book.reserve({ orderId: 'o2', sku: 'cap', quantity: 3 });
  book.commit(a.id);
  const released = book.release(a.id);
  assert.equal(released.status, 'committed');
  assert.equal(stock.level('cap', 'w1').held, 3);
  assert.equal(stock.level('cap', 'w1').onHand, 4);
  assert.equal(book.available('cap'), 5);
});

test('commit expires due holds first', () => {
  const { clock, stock, book } = setup();
  const hold = book.reserve({ orderId: 'o1', sku: 'cap', quantity: 2 });
  clock.set(10 * MIN);
  assert.throws(() => book.commit(hold.id), /reservation_expired/);
  assert.equal(stock.level('cap', 'w1').onHand, 6);
  assert.equal(stock.level('cap', 'w1').held, 0);
});

test('commit of a released reservation throws reservation_not_held', () => {
  const { book } = setup();
  const hold = book.reserve({ orderId: 'o1', sku: 'cap', quantity: 2 });
  book.release(hold.id);
  assert.throws(() => book.commit(hold.id), /reservation_not_held/);
  assert.throws(() => book.release('res_99'), /reservation_not_found/);
});

test('cannot oversell across many reservations', () => {
  const { book } = setup();
  const first = book.reserve({ orderId: 'o1', sku: 'cap', quantity: 8 });
  const second = book.reserve({ orderId: 'o2', sku: 'cap', quantity: 5 });
  assert.equal(first.backorderQuantity, 0);
  assert.deepEqual(second.lines, [{ warehouse: 'w2', quantity: 2 }]);
  assert.equal(second.backorderQuantity, 3);
  const third = book.reserve({ orderId: 'o3', sku: 'cap', quantity: 1 });
  assert.deepEqual(third.lines, []);
  assert.equal(third.backorderQuantity, 1);
  assert.equal(book.available('cap'), 0);
});

test('quantity must be a safe integer and request fields non-empty strings', () => {
  const { book } = setup();
  for (const quantity of [2 ** 53, '2', NaN, Infinity, undefined])
    assert.throws(() => book.reserve({ orderId: 'o1', sku: 'cap', quantity }), /invalid_quantity/);
  for (const request of [{ orderId: '', sku: 'cap', quantity: 1 }, { orderId: 'o1', sku: 5, quantity: 1 }, undefined])
    assert.throws(() => book.reserve(request), /invalid_request/);
});

test('reservation ids are sequential and returned copies are detached', () => {
  const { book, stock } = setup();
  const a = book.reserve({ orderId: 'o1', sku: 'cap', quantity: 2 });
  const b = book.reserve({ orderId: 'o2', sku: 'cap', quantity: 1 });
  assert.equal(a.id, 'res_1');
  assert.equal(b.id, 'res_2');
  a.lines[0].quantity = 100;
  a.status = 'committed';
  book.release(a.id);
  assert.equal(stock.level('cap', 'w1').held, 1);
});

test('audit entries record each state change', () => {
  const { clock, book } = setup();
  const a = book.reserve({ orderId: 'o1', sku: 'cap', quantity: 1 });
  const b = book.reserve({ orderId: 'o2', sku: 'cap', quantity: 1 });
  const c = book.reserve({ orderId: 'o3', sku: 'cap', quantity: 1 });
  clock.set(MIN);
  book.release(a.id);
  book.commit(b.id);
  clock.set(10 * MIN);
  book.available('cap');
  assert.deepEqual(book.audit.entries(), [
    { type: 'reserved', reservationId: a.id, at: 0 },
    { type: 'reserved', reservationId: b.id, at: 0 },
    { type: 'reserved', reservationId: c.id, at: 0 },
    { type: 'released', reservationId: a.id, at: MIN },
    { type: 'committed', reservationId: b.id, at: MIN },
    { type: 'expired', reservationId: c.id, at: 10 * MIN },
  ]);
});
