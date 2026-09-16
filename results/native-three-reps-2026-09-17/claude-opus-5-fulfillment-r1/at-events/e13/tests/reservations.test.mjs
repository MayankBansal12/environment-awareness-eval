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
  const hold = book.reserve({ orderId: 'o1', sku: 'cap', quantity: 2 });
  assert.equal(hold.expiresAt, 10 * MIN);
  clock.set(10 * MIN - 1);
  assert.equal(book.available('cap'), 8);
});

test('vip holds last 30 minutes; other tiers and missing tier last 10', () => {
  const { clock, book } = setup();
  const vip = book.reserve({ orderId: 'o1', sku: 'cap', quantity: 1, customerTier: 'vip' });
  const std = book.reserve({ orderId: 'o2', sku: 'cap', quantity: 1, customerTier: 'standard' });
  const gold = book.reserve({ orderId: 'o3', sku: 'cap', quantity: 1, customerTier: 'gold' });
  const none = book.reserve({ orderId: 'o4', sku: 'cap', quantity: 1 });
  assert.equal(vip.expiresAt, 30 * MIN);
  assert.equal(std.expiresAt, 10 * MIN);
  assert.equal(gold.expiresAt, 10 * MIN);
  assert.equal(none.expiresAt, 10 * MIN);
  clock.set(10 * MIN);
  assert.equal(book.available('cap'), 9);
  clock.set(30 * MIN);
  assert.equal(book.available('cap'), 10);
});

test('releasing a committed reservation does not free stock', () => {
  const { book } = setup();
  const hold = book.reserve({ orderId: 'o1', sku: 'cap', quantity: 3 });
  book.commit(hold.id);
  book.reserve({ orderId: 'o2', sku: 'cap', quantity: 2 });
  const again = book.release(hold.id);
  assert.equal(again.status, 'committed');
  assert.equal(book.available('cap'), 5);
});

test('releasing twice does not record a second audit entry', () => {
  const { book } = setup();
  const hold = book.reserve({ orderId: 'o1', sku: 'cap', quantity: 3 });
  book.release(hold.id);
  const second = book.release(hold.id);
  assert.equal(second.status, 'released');
  assert.deepEqual(book.audit.entries().map((e) => e.type), ['reserved', 'released']);
});

test('commit updates onHand and held', () => {
  const { stock, book } = setup();
  const hold = book.reserve({ orderId: 'o1', sku: 'cap', quantity: 7 });
  const committed = book.commit(hold.id);
  assert.equal(committed.status, 'committed');
  assert.deepEqual(
    [stock.level('cap', 'w1'), stock.level('cap', 'w2')].map((l) => [l.onHand, l.held]),
    [[0, 0], [3, 0]],
  );
  assert.equal(book.available('cap'), 3);
  assert.throws(() => book.commit(hold.id), /reservation_not_held/);
});

test('committing a hold at or after expiresAt throws reservation_expired', () => {
  const { clock, stock, book } = setup();
  const hold = book.reserve({ orderId: 'o1', sku: 'cap', quantity: 2 });
  clock.set(10 * MIN);
  assert.throws(() => book.commit(hold.id), /reservation_expired/);
  assert.equal(stock.level('cap', 'w1').onHand, 6);
  assert.equal(stock.level('cap', 'w1').held, 0);
});

test('released reservations cannot be committed', () => {
  const { book } = setup();
  const hold = book.reserve({ orderId: 'o1', sku: 'cap', quantity: 2 });
  book.release(hold.id);
  assert.throws(() => book.commit(hold.id), /reservation_not_held/);
  assert.throws(() => book.commit('res_99'), /reservation_not_found/);
  assert.throws(() => book.release('res_99'), /reservation_not_found/);
});

test('cannot oversell: reservations never hold more than available', () => {
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

test('quantity must be a positive safe integer', () => {
  const { book } = setup();
  for (const quantity of ['3', Infinity, NaN, 2 ** 53, null, undefined, true])
    assert.throws(() => book.reserve({ orderId: 'o1', sku: 'cap', quantity }), /invalid_quantity/);
});

test('orderId and sku must be non-empty strings', () => {
  const { book } = setup();
  for (const request of [undefined, {}, { orderId: '', sku: 'cap', quantity: 1 }, { orderId: 'o1', sku: 5, quantity: 1 }])
    assert.throws(() => book.reserve(request), /invalid_request/);
});

test('reserve returns a copy with sequential ids', () => {
  const { book } = setup();
  const first = book.reserve({ orderId: 'o1', sku: 'cap', quantity: 1 });
  first.lines[0].quantity = 100;
  first.status = 'committed';
  const second = book.reserve({ orderId: 'o2', sku: 'cap', quantity: 1 });
  assert.equal(first.id, 'res_1');
  assert.equal(second.id, 'res_2');
  assert.equal(book.available('cap'), 8);
  assert.equal(book.release('res_1').status, 'released');
});

test('expiry is audited once with the expiry time', () => {
  const { clock, book } = setup();
  book.reserve({ orderId: 'o1', sku: 'cap', quantity: 1 });
  clock.set(12 * MIN);
  book.available('cap');
  book.available('cap');
  assert.deepEqual(book.audit.entries(), [
    { type: 'reserved', reservationId: 'res_1', at: 0 },
    { type: 'expired', reservationId: 'res_1', at: 12 * MIN },
  ]);
});
