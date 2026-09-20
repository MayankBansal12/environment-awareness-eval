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

test('a hold is still active just before expiresAt', () => {
  const { clock, book } = setup();
  book.reserve({ orderId: 'o1', sku: 'cap', quantity: 2 });
  clock.set(10 * MIN - 1);
  assert.equal(book.available('cap'), 8);
});

test('vip holds last 30 minutes; other and missing tiers last 10', () => {
  const { clock, book } = setup();
  const vip = book.reserve({ orderId: 'o1', sku: 'cap', quantity: 1, customerTier: 'vip' });
  const std = book.reserve({ orderId: 'o2', sku: 'cap', quantity: 1, customerTier: 'standard' });
  const none = book.reserve({ orderId: 'o3', sku: 'cap', quantity: 1 });
  assert.equal(vip.expiresAt, 30 * MIN);
  assert.equal(std.expiresAt, 10 * MIN);
  assert.equal(none.expiresAt, 10 * MIN);
  clock.set(10 * MIN);
  assert.equal(book.available('cap'), 9);
  clock.set(30 * MIN);
  assert.equal(book.available('cap'), 10);
});

test('releasing a committed reservation does not free stock again', () => {
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

test('release returns non-held reservations unchanged and rejects unknown ids', () => {
  const { book } = setup();
  const hold = book.reserve({ orderId: 'o1', sku: 'cap', quantity: 1 });
  book.release(hold.id);
  assert.equal(book.audit.entries().filter((e) => e.type === 'released').length, 1);
  assert.equal(book.release(hold.id).status, 'released');
  assert.equal(book.audit.entries().filter((e) => e.type === 'released').length, 1);
  assert.throws(() => book.release('res_99'), /reservation_not_found/);
});

test('commit expires due holds first', () => {
  const { clock, stock, book } = setup();
  const hold = book.reserve({ orderId: 'o1', sku: 'cap', quantity: 2 });
  clock.set(10 * MIN);
  assert.throws(() => book.commit(hold.id), /reservation_expired/);
  assert.equal(stock.level('cap', 'w1').onHand, 6);
  assert.equal(stock.level('cap', 'w1').held, 0);
  assert.deepEqual(
    book.audit.entries().map((e) => e.type),
    ['reserved', 'expired'],
  );
});

test('commit rejects non-held reservations', () => {
  const { book } = setup();
  const hold = book.reserve({ orderId: 'o1', sku: 'cap', quantity: 2 });
  book.release(hold.id);
  assert.throws(() => book.commit(hold.id), /reservation_not_held/);
  assert.throws(() => book.commit('nope'), /reservation_not_found/);
});

test('cannot hold more than is available (no oversell)', () => {
  const { stock, book } = setup();
  book.reserve({ orderId: 'o1', sku: 'cap', quantity: 8 });
  const second = book.reserve({ orderId: 'o2', sku: 'cap', quantity: 5 });
  assert.deepEqual(second.lines, [{ warehouse: 'w2', quantity: 2 }]);
  assert.equal(second.backorderQuantity, 3);
  const third = book.reserve({ orderId: 'o3', sku: 'cap', quantity: 1 });
  assert.deepEqual(third.lines, []);
  assert.equal(third.backorderQuantity, 1);
  assert.equal(stock.level('cap', 'w1').held, 6);
  assert.equal(stock.level('cap', 'w2').held, 4);
  assert.equal(book.available('cap'), 0);
});

test('quantity must be a safe integer number', () => {
  const { book } = setup();
  for (const quantity of ['5', 2 ** 53, NaN, Infinity, undefined, null])
    assert.throws(() => book.reserve({ orderId: 'o1', sku: 'cap', quantity }), /invalid_quantity/);
  for (const bad of [{ orderId: '', sku: 'cap' }, { orderId: 'o1', sku: 5 }])
    assert.throws(() => book.reserve({ ...bad, quantity: 1 }), /invalid_request/);
});

test('returned reservations are copies', () => {
  const { book } = setup();
  const hold = book.reserve({ orderId: 'o1', sku: 'cap', quantity: 1 });
  hold.status = 'committed';
  hold.lines[0].quantity = 100;
  assert.equal(book.release(hold.id).status, 'released');
  assert.equal(book.available('cap'), 10);
});
