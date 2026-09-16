import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Stock } from '../src/stock.mjs';
import { ReservationBook } from '../src/reservations.mjs';
import { AuditLog } from '../src/audit.mjs';
import { allocate } from '../src/allocation.mjs';

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

test('allocation never takes more than the available (onHand - held) quantity', () => {
  const levels = [
    { warehouse: 'w1', sku: 'cap', onHand: 6, held: 4, priority: 1 },
    { warehouse: 'w2', sku: 'cap', onHand: 4, held: 0, priority: 2 },
  ];
  // Only 2 available at w1 (6 - 4), 4 available at w2: total 6, requesting 5 should not
  // oversell w1 by taking its full onHand.
  const { lines, backorderQuantity } = allocate(levels, 5);
  assert.deepEqual(lines, [
    { warehouse: 'w1', quantity: 2 },
    { warehouse: 'w2', quantity: 3 },
  ]);
  assert.equal(backorderQuantity, 0);
});

test('allocation ties on priority are broken by warehouse id ascending', () => {
  const levels = [
    { warehouse: 'w9', sku: 'cap', onHand: 5, held: 0, priority: 1 },
    { warehouse: 'w2', sku: 'cap', onHand: 5, held: 0, priority: 1 },
  ];
  const { lines } = allocate(levels, 3);
  assert.deepEqual(lines, [{ warehouse: 'w2', quantity: 3 }]);
});

test('a second reservation cannot oversell stock already held by another reservation', () => {
  const { book } = setup();
  book.reserve({ orderId: 'o1', sku: 'cap', quantity: 10 });
  const second = book.reserve({ orderId: 'o2', sku: 'cap', quantity: 1 });
  assert.deepEqual(second.lines, []);
  assert.equal(second.backorderQuantity, 1);
});

test('committing a reservation whose hold has expired throws and does not commit', () => {
  const { clock, book } = setup();
  const hold = book.reserve({ orderId: 'o1', sku: 'cap', quantity: 2 });
  clock.set(10 * MIN); // exactly at expiresAt: hold has expired per the >= rule
  assert.throws(() => book.commit(hold.id), /reservation_expired/);
});

test('releasing a committed reservation is a no-op and does not free stock twice', () => {
  const { book } = setup();
  const hold = book.reserve({ orderId: 'o1', sku: 'cap', quantity: 3 });
  book.commit(hold.id);
  const afterCommit = book.available('cap');
  const released = book.release(hold.id);
  assert.equal(released.status, 'committed');
  assert.equal(book.available('cap'), afterCommit);
});

test('vip customers get a 30 minute hold, other tiers (including missing) get 10 minutes', () => {
  const { clock, book } = setup();
  const vip = book.reserve({ orderId: 'o1', sku: 'cap', quantity: 1, customerTier: 'vip' });
  const standard = book.reserve({ orderId: 'o2', sku: 'cap', quantity: 1, customerTier: 'standard' });
  const untiered = book.reserve({ orderId: 'o3', sku: 'cap', quantity: 1 });
  assert.equal(vip.expiresAt, 30 * MIN);
  assert.equal(standard.expiresAt, 10 * MIN);
  assert.equal(untiered.expiresAt, 10 * MIN);

  clock.set(10 * MIN);
  book.available('cap'); // triggers expireDue: standard/untiered are expired, vip is not
  assert.equal(book.release(vip.id).status, 'released');
  assert.equal(book.release(standard.id).status, 'expired');
  assert.equal(book.release(untiered.id).status, 'expired');
});

test('audit log entries cannot be mutated after the fact', () => {
  const audit = new AuditLog();
  const entry = { type: 'reserved', reservationId: 'res_1', at: 0 };
  audit.record(entry);
  entry.type = 'tampered'; // mutating the original object must not affect the log

  const first = audit.entries();
  first[0].type = 'also-tampered'; // mutating a returned entry must not affect the log
  first.push({ type: 'injected', reservationId: 'res_x', at: 1 }); // mutating the array must not affect the log

  const second = audit.entries();
  assert.deepEqual(second, [{ type: 'reserved', reservationId: 'res_1', at: 0 }]);
});
