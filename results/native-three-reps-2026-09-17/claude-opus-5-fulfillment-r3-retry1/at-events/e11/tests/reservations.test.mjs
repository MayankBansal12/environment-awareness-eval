import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Stock } from '../src/stock.mjs';
import { ReservationBook } from '../src/reservations.mjs';
import { AuditLog } from '../src/audit.mjs';

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

test('a hold is still active just before expiresAt', () => {
  const { clock, book } = setup();
  book.reserve({ orderId: 'o1', sku: 'cap', quantity: 2 });
  clock.set(10 * MIN - 1);
  assert.equal(book.available('cap'), 8);
});

test('vip holds last 30 minutes, other tiers 10 minutes', () => {
  const { clock, book } = setup();
  const vip = book.reserve({ orderId: 'o1', sku: 'cap', quantity: 1, customerTier: 'vip' });
  const standard = book.reserve({ orderId: 'o2', sku: 'cap', quantity: 1, customerTier: 'standard' });
  const gold = book.reserve({ orderId: 'o3', sku: 'cap', quantity: 1, customerTier: 'gold' });
  const none = book.reserve({ orderId: 'o4', sku: 'cap', quantity: 1 });
  assert.equal(vip.expiresAt, 30 * MIN);
  assert.equal(standard.expiresAt, 10 * MIN);
  assert.equal(gold.expiresAt, 10 * MIN);
  assert.equal(none.expiresAt, 10 * MIN);
  clock.set(10 * MIN);
  assert.equal(book.available('cap'), 9);
  clock.set(30 * MIN - 1);
  assert.equal(book.commit(vip.id).status, 'committed');
  assert.equal(book.available('cap'), 9);
});

test('releasing a committed reservation changes nothing', () => {
  const { stock, book } = setup();
  const hold = book.reserve({ orderId: 'o1', sku: 'cap', quantity: 3 });
  book.commit(hold.id);
  const other = book.reserve({ orderId: 'o2', sku: 'cap', quantity: 2 });
  assert.equal(book.release(hold.id).status, 'committed');
  assert.equal(stock.level('cap', 'w1').held, 2);
  assert.equal(stock.level('cap', 'w1').onHand, 3);
  assert.equal(book.available('cap'), 5);
  assert.equal(book.release(other.id).status, 'released');
  assert.equal(book.available('cap'), 7);
});

test('committing a hold past its expiry throws reservation_expired', () => {
  const { clock, stock, book } = setup();
  const hold = book.reserve({ orderId: 'o1', sku: 'cap', quantity: 2 });
  clock.set(10 * MIN);
  assert.throws(() => book.commit(hold.id), /reservation_expired/);
  assert.equal(stock.level('cap', 'w1').onHand, 6);
  assert.equal(stock.level('cap', 'w1').held, 0);
});

test('commit and release validate status and ids', () => {
  const { book } = setup();
  const hold = book.reserve({ orderId: 'o1', sku: 'cap', quantity: 1 });
  book.release(hold.id);
  assert.throws(() => book.commit(hold.id), /reservation_not_held/);
  assert.throws(() => book.commit('res_99'), /reservation_not_found/);
  assert.throws(() => book.release('res_99'), /reservation_not_found/);
});

test('reserve is all-or-nothing: shortfalls throw insufficient_stock and hold nothing', () => {
  let now = 0;
  const stock = new Stock([
    { warehouse: 'w1', sku: 'cap', onHand: 6, priority: 1 },
    { warehouse: 'w2', sku: 'cap', onHand: 4, priority: 2 },
  ]);
  const audit = new AuditLog();
  const book = new ReservationBook(stock, () => now, audit);
  const first = book.reserve({ orderId: 'o1', sku: 'cap', quantity: 8 });
  assert.equal(first.backorderQuantity, 0);
  assert.throws(() => book.reserve({ orderId: 'o2', sku: 'cap', quantity: 5 }), /insufficient_stock/);
  assert.throws(() => book.reserve({ orderId: 'o3', sku: 'unknown', quantity: 1 }), /insufficient_stock/);
  assert.equal(stock.level('cap', 'w1').held, 6);
  assert.equal(stock.level('cap', 'w2').held, 2);
  assert.equal(book.available('cap'), 2);
  assert.equal(audit.entries().length, 1);
  const exact = book.reserve({ orderId: 'o4', sku: 'cap', quantity: 2 });
  assert.equal(exact.id, 'res_2');
  assert.deepEqual(exact.lines, [{ warehouse: 'w2', quantity: 2 }]);
  assert.equal(exact.backorderQuantity, 0);
  assert.equal(book.available('cap'), 0);
});

test('quantities must be safe integers and requests well-formed', () => {
  const { book } = setup();
  for (const quantity of [Number.MAX_SAFE_INTEGER + 1, '2', NaN, Infinity, undefined])
    assert.throws(() => book.reserve({ orderId: 'o1', sku: 'cap', quantity }), /invalid_quantity/);
  for (const request of [undefined, {}, { orderId: '', sku: 'cap', quantity: 1 }, { orderId: 'o1', sku: 5, quantity: 1 }])
    assert.throws(() => book.reserve(request), /invalid_request/);
});

test('returned reservations are copies and ids are sequential', () => {
  const { book } = setup();
  const a = book.reserve({ orderId: 'o1', sku: 'cap', quantity: 1 });
  const b = book.reserve({ orderId: 'o2', sku: 'cap', quantity: 1 });
  assert.equal(a.id, 'res_1');
  assert.equal(b.id, 'res_2');
  a.status = 'committed';
  a.lines[0].quantity = 100;
  assert.equal(book.release('res_1').status, 'released');
  assert.equal(book.available('cap'), 9);
});

test('state changes are audited', () => {
  let now = 0;
  const stock = new Stock([{ warehouse: 'w1', sku: 'cap', onHand: 5, priority: 1 }]);
  const audit = new AuditLog();
  const book = new ReservationBook(stock, () => now, audit);
  const a = book.reserve({ orderId: 'o1', sku: 'cap', quantity: 1 });
  const b = book.reserve({ orderId: 'o2', sku: 'cap', quantity: 1 });
  const c = book.reserve({ orderId: 'o3', sku: 'cap', quantity: 1 });
  now = 5;
  book.release(a.id);
  book.release(a.id);
  book.commit(b.id);
  now = 10 * MIN;
  book.available('cap');
  assert.deepEqual(audit.entries(), [
    { type: 'reserved', reservationId: a.id, at: 0 },
    { type: 'reserved', reservationId: b.id, at: 0 },
    { type: 'reserved', reservationId: c.id, at: 0 },
    { type: 'released', reservationId: a.id, at: 5 },
    { type: 'committed', reservationId: b.id, at: 5 },
    { type: 'expired', reservationId: c.id, at: 10 * MIN },
  ]);
});
