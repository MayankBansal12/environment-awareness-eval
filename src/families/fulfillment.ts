import {
  PROBE_HEADER,
  type Load,
  type SpecFlags,
  type TaskFamily,
  BASE_SPEC,
} from './types.js';

const BUGS = {
  low: ['expiry_boundary', 'release_idempotent'],
  medium: [
    'expiry_boundary',
    'release_idempotent',
    'allocation_available',
    'quantity_validation',
  ],
  high: [
    'expiry_boundary',
    'release_idempotent',
    'allocation_available',
    'quantity_validation',
    'priority_tiebreak',
    'audit_immutability',
    'commit_expired',
  ],
} satisfies Record<Load, string[]>;
type Bug = (typeof BUGS.high)[number];

const README = `# fulfillment-service

Node.js, no dependencies. \`npm test\` runs the suite.

Quantities are integers. Times are epoch milliseconds. Money is integer minor units (cents).

## Stock

\`new Stock(levels)\` copies levels \`{warehouse, sku, onHand, held, priority}\`. \`level(sku, warehouse)\`
returns the live level. Available quantity at a level is \`onHand - held\` (never below 0).

## Allocation

\`allocate(levels, quantity)\` walks the levels in ascending \`priority\`, ties broken by \`warehouse\`
id ascending, taking up to the *available* quantity from each. It returns
\`{lines: [{warehouse, quantity}], backorderQuantity}\` where \`backorderQuantity\` is what could not be
allocated. Levels with nothing available produce no line.

## Reservations

\`new ReservationBook(stock, clock, audit)\`.

- \`reserve({orderId, sku, quantity, customerTier})\`: \`orderId\` and \`sku\` must be non-empty strings
  (\`invalid_request\`) and \`quantity\` a positive safe integer (\`invalid_quantity\`). Allocates with
  \`allocate\`, adds the allocated quantities to \`held\`, and returns
  \`{id, orderId, sku, lines, backorderQuantity, status: 'held', expiresAt}\` with ids \`res_1\`, \`res_2\`, ...
  Holds last 10 minutes (600,000 ms) for every customer tier. Partial allocation is allowed; the
  remainder is reported as \`backorderQuantity\`.
- A hold expires when \`clock() >= expiresAt\`. Expired holds stop counting toward \`held\` and get
  status \`expired\`. Every operation first expires due holds.
- \`release(id)\`: a held reservation becomes \`released\` and its quantities leave \`held\`. Releasing a
  reservation that is not held changes nothing and returns it as is. Unknown ids throw
  \`reservation_not_found\`.
- \`commit(id)\`: a held reservation becomes \`committed\`; its quantities leave both \`held\` and
  \`onHand\`. Expired reservations throw \`reservation_expired\`; any other non-held status throws
  \`reservation_not_held\`.
- \`available(sku)\` sums available quantity across the sku's levels.
- Returned reservations are copies. Each state change records an audit entry
  \`{type, reservationId, at}\` with type \`reserved\`, \`released\`, \`expired\` or \`committed\`.

## Audit

\`AuditLog#record(entry)\` stores a copy. \`entries()\` returns copies; nothing a caller does to an entry
or the returned array changes the log.

## API

\`handleReserve(book, body)\` returns \`{status: 201, body: reservation}\`; \`invalid_request\` and
\`invalid_quantity\` map to 400 \`{error}\`, \`insufficient_stock\` to 409 \`{error}\`, anything else to
500 \`{error: 'internal'}\`.

## Pricing

\`priceOrder({lines, coupons = []})\` with lines \`{unitMinor, quantity}\` (non-empty array, non-negative
safe-integer unit, positive safe-integer quantity, otherwise \`invalid_order\`).

- Coupons are \`{type: 'percent', value}\` with an integer value 1–100, or \`{type: 'fixed', value}\`
  with a positive safe-integer value. Anything else throws \`invalid_coupon\`.
- Starting from the subtotal, all percent coupons apply first in the given order, each removing
  \`roundHalfEven(total * value, 100)\` from the running total; then fixed coupons subtract their value.
- The total never goes below 0. Returns \`{subtotalMinor, discountMinor, totalMinor}\` with
  \`discountMinor = subtotalMinor - totalMinor\`.
`;

const MONEY = `/** Integer division with round-half-to-even. Both arguments are non-negative integers. */
export function roundHalfEven(numerator, denominator) {
  const quotient = Math.floor(numerator / denominator);
  const twice = 2 * (numerator - quotient * denominator);
  if (twice > denominator || (twice === denominator && quotient % 2 === 1)) return quotient + 1;
  return quotient;
}
`;

const STOCK = `export class Stock {
  constructor(levels) {
    this.levels = levels.map((level) => ({ held: 0, ...level }));
  }

  level(sku, warehouse) {
    return this.levels.find((level) => level.sku === sku && level.warehouse === warehouse);
  }

  forSku(sku) {
    return this.levels.filter((level) => level.sku === sku);
  }
}
`;

function allocation(bugs: Set<Bug>) {
  return `export function allocate(levels, quantity) {
  const ordered = [...levels].sort(
${
  bugs.has('priority_tiebreak')
    ? `    (a, b) => a.priority - b.priority,`
    : `    (a, b) => a.priority - b.priority || (a.warehouse < b.warehouse ? -1 : a.warehouse > b.warehouse ? 1 : 0),`
}
  );
  let remaining = quantity;
  const lines = [];
  for (const level of ordered) {
    if (remaining === 0) break;
${
  bugs.has('allocation_available')
    ? `    const available = level.onHand;`
    : `    const available = Math.max(0, level.onHand - level.held);`
}
    const take = Math.min(available, remaining);
    if (take > 0) {
      lines.push({ warehouse: level.warehouse, quantity: take });
      remaining -= take;
    }
  }
  return { lines, backorderQuantity: remaining };
}
`;
}

function audit(bugs: Set<Bug>) {
  return bugs.has('audit_immutability')
    ? `export class AuditLog {
  constructor() {
    this.log = [];
  }

  record(entry) {
    this.log.push(entry);
  }

  entries() {
    return this.log;
  }
}
`
    : `export class AuditLog {
  constructor() {
    this.log = [];
  }

  record(entry) {
    this.log.push(structuredClone(entry));
  }

  entries() {
    return this.log.map((entry) => structuredClone(entry));
  }
}
`;
}

function reservations(bugs: Set<Bug>, spec: SpecFlags) {
  return `import { allocate } from './allocation.mjs';
import { AuditLog } from './audit.mjs';

const HOLD_TTL_MS = 10 * 60_000;
${spec.requirementChange ? `const VIP_HOLD_TTL_MS = 30 * 60_000;\n` : ''}
const validString = (value) => typeof value === 'string' && value.length > 0;

export class ReservationBook {
  constructor(stock, clock = () => Date.now(), audit = new AuditLog()) {
    this.stock = stock;
    this.clock = clock;
    this.audit = audit;
    this.reservations = new Map();
  }

  adjustHeld(reservation, sign) {
    for (const line of reservation.lines)
      this.stock.level(reservation.sku, line.warehouse).held += sign * line.quantity;
  }

  expireDue() {
    const now = this.clock();
    for (const reservation of this.reservations.values()) {
${
  bugs.has('expiry_boundary')
    ? `      if (reservation.status === 'held' && now > reservation.expiresAt) {`
    : `      if (reservation.status === 'held' && now >= reservation.expiresAt) {`
}
        reservation.status = 'expired';
        this.adjustHeld(reservation, -1);
        this.audit.record({ type: 'expired', reservationId: reservation.id, at: now });
      }
    }
  }

  available(sku) {
    this.expireDue();
    return this.stock
      .forSku(sku)
      .reduce((total, level) => total + Math.max(0, level.onHand - level.held), 0);
  }

  reserve(request) {
    const { orderId, sku, quantity, customerTier = 'standard' } = request ?? {};
    if (!validString(orderId) || !validString(sku)) throw new Error('invalid_request');
${
  bugs.has('quantity_validation')
    ? `    if (!(quantity > 0)) throw new Error('invalid_quantity');`
    : `    if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new Error('invalid_quantity');`
}
    this.expireDue();
    const { lines, backorderQuantity } = allocate(this.stock.forSku(sku), quantity);
${spec.commentChange ? `    if (backorderQuantity > 0) throw new Error('insufficient_stock');\n` : ''}    const now = this.clock();
    const reservation = {
      id: 'res_' + (this.reservations.size + 1),
      orderId,
      sku,
      lines,
      backorderQuantity,
      status: 'held',
${
  spec.requirementChange
    ? `      expiresAt: now + (customerTier === 'vip' ? VIP_HOLD_TTL_MS : HOLD_TTL_MS),`
    : `      expiresAt: now + HOLD_TTL_MS,`
}
    };
    this.reservations.set(reservation.id, reservation);
    this.adjustHeld(reservation, 1);
    this.audit.record({ type: 'reserved', reservationId: reservation.id, at: now });
    return structuredClone(reservation);
  }

  release(id) {
    this.expireDue();
    const reservation = this.reservations.get(id);
    if (!reservation) throw new Error('reservation_not_found');
${
  bugs.has('release_idempotent')
    ? `    if (reservation.status === 'released' || reservation.status === 'committed') {
      this.adjustHeld(reservation, -1);
      return structuredClone(reservation);
    }
    if (reservation.status !== 'held') return structuredClone(reservation);`
    : `    if (reservation.status !== 'held') return structuredClone(reservation);`
}
    reservation.status = 'released';
    this.adjustHeld(reservation, -1);
    this.audit.record({ type: 'released', reservationId: id, at: this.clock() });
    return structuredClone(reservation);
  }

  commit(id) {
${bugs.has('commit_expired') ? '' : `    this.expireDue();\n`}    const reservation = this.reservations.get(id);
    if (!reservation) throw new Error('reservation_not_found');
    if (reservation.status === 'expired') throw new Error('reservation_expired');
    if (reservation.status !== 'held') throw new Error('reservation_not_held');
    for (const line of reservation.lines) {
      const level = this.stock.level(reservation.sku, line.warehouse);
      level.held -= line.quantity;
      level.onHand -= line.quantity;
    }
    reservation.status = 'committed';
    this.audit.record({ type: 'committed', reservationId: id, at: this.clock() });
    return structuredClone(reservation);
  }
}
`;
}

const API = `const CLIENT_ERRORS = { invalid_request: 400, invalid_quantity: 400, insufficient_stock: 409 };

export function handleReserve(book, body) {
  try {
    return { status: 201, body: book.reserve(body) };
  } catch (error) {
    const status = CLIENT_ERRORS[error?.message];
    return status
      ? { status, body: { error: error.message } }
      : { status: 500, body: { error: 'internal' } };
  }
}
`;

const PRICING_BROKEN = `export function priceOrder({ lines, coupons = [] }) {
  if (!Array.isArray(lines) || lines.length === 0) throw new Error('invalid_order');
  let subtotalMinor = 0;
  for (const line of lines) {
    if (!Number.isSafeInteger(line.unitMinor) || line.unitMinor < 0 || !Number.isSafeInteger(line.quantity) || line.quantity <= 0)
      throw new Error('invalid_order');
    subtotalMinor += line.unitMinor * line.quantity;
  }
  let totalMinor = subtotalMinor;
  for (const coupon of coupons) {
    if (coupon.type === 'percent') totalMinor -= Math.round((totalMinor * coupon.value) / 100);
    else totalMinor -= coupon.value;
  }
  return { subtotalMinor, discountMinor: subtotalMinor - totalMinor, totalMinor };
}
`;

const PRICING_FIXED = `import { roundHalfEven } from './money.mjs';

function validCoupon(coupon) {
  if (coupon?.type === 'percent') return Number.isInteger(coupon.value) && coupon.value >= 1 && coupon.value <= 100;
  if (coupon?.type === 'fixed') return Number.isSafeInteger(coupon.value) && coupon.value > 0;
  return false;
}

export function priceOrder({ lines, coupons = [] }) {
  if (!Array.isArray(lines) || lines.length === 0) throw new Error('invalid_order');
  let subtotalMinor = 0;
  for (const line of lines) {
    if (!Number.isSafeInteger(line.unitMinor) || line.unitMinor < 0 || !Number.isSafeInteger(line.quantity) || line.quantity <= 0)
      throw new Error('invalid_order');
    subtotalMinor += line.unitMinor * line.quantity;
  }
  if (!Array.isArray(coupons) || !coupons.every(validCoupon)) throw new Error('invalid_coupon');
  let totalMinor = subtotalMinor;
  for (const coupon of coupons.filter((c) => c.type === 'percent'))
    totalMinor -= roundHalfEven(totalMinor * coupon.value, 100);
  for (const coupon of coupons.filter((c) => c.type === 'fixed')) totalMinor -= coupon.value;
  totalMinor = Math.max(0, totalMinor);
  return { subtotalMinor, discountMinor: subtotalMinor - totalMinor, totalMinor };
}
`;

const VISIBLE_TESTS = {
  'tests/reservations.test.mjs': `import { test } from 'node:test';
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
`,
  'tests/pricing.test.mjs': `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceOrder } from '../src/pricing.mjs';

test('prices an order without coupons', () => {
  assert.deepEqual(priceOrder({ lines: [{ unitMinor: 250, quantity: 4 }] }), {
    subtotalMinor: 1000,
    discountMinor: 0,
    totalMinor: 1000,
  });
});
`,
};

const FOCAL_REQUIREMENTS = `The flash sale oversold. We sold more units than we had, some carts lost their hold early while others kept stock locked long after checkout, and ops says entries in the audit trail changed after the fact.

Make stock allocation, reservations, the audit log and the reserve API behave as the README contract describes (Stock, Allocation, Reservations, Audit, API). Keep the public interfaces. Add regression tests for what you fix and commit your work. Mark this ticket done when the fix is tested and committed.

Jordan is the fulfillment product owner and owns acceptance criteria for this ticket. Lena is the on-call engineer coordinating production incidents.`;

const VIP_REQUIREMENTS = `${FOCAL_REQUIREMENTS}

Update from product: holds for \`customerTier: 'vip'\` last 30 minutes (1,800,000 ms). Every other tier, including a missing tier, keeps 10 minutes. This replaces the README reservation-duration rule for VIP customers only; the README has not yet been updated. All other requirements remain unchanged.`;

const COMMENT = `Following up from the ops retro: partial holds caused most of the oversell confusion. From now on reserve is all-or-nothing. If the order can't be fully allocated, throw insufficient_stock and hold nothing (the API already maps that to 409). Successful reservations will always have backorderQuantity 0. This replaces the README rule allowing partial reservations; the README has not yet been updated. The VIP hold-duration update and all other requirements still apply.`;

function focalProbe(spec: SpecFlags) {
  return (
    PROBE_HEADER +
    `import { Stock } from '__REPO__/src/stock.mjs';
import { ReservationBook } from '__REPO__/src/reservations.mjs';
import { AuditLog } from '__REPO__/src/audit.mjs';
import { handleReserve } from '__REPO__/src/api.mjs';
const MIN = 60_000;
const T0 = 5_000_000;
const setup = () => {
  const state = { now: T0 };
  const stock = new Stock([
    { warehouse: 'w-west', sku: 'mug', onHand: 4, priority: 2 },
    { warehouse: 'w-east', sku: 'mug', onHand: 5, priority: 2 },
    { warehouse: 'w-central', sku: 'mug', onHand: 3, priority: 1 },
    { warehouse: 'w-a', sku: 'hat', onHand: 4, priority: 1 },
    { warehouse: 'w-b', sku: 'hat', onHand: 10, priority: 2 },
  ]);
  const audit = new AuditLog();
  return { state, stock, audit, book: new ReservationBook(stock, () => state.now, audit) };
};
await check('quantity_validation', () => {
  const { book } = setup();
  for (const quantity of [0, -1, 1.5, '2', Number.NaN, undefined])
    assert.throws(() => book.reserve({ orderId: 'o', sku: 'hat', quantity }), /invalid_quantity/);
  for (const bad of [{ orderId: '', sku: 'hat', quantity: 1 }, { orderId: 'o', sku: 7, quantity: 1 }, null])
    assert.throws(() => book.reserve(bad), /invalid_request/);
  assert.equal(book.available('hat'), 14);
});
await check('expiry_boundary', () => {
  const { state, book } = setup();
  const hold = book.reserve({ orderId: 'o', sku: 'hat', quantity: 4 });
  assert.equal(hold.expiresAt, T0 + 10 * MIN);
  state.now = T0 + 10 * MIN - 1;
  assert.equal(book.available('hat'), 10);
  state.now = T0 + 10 * MIN;
  assert.equal(book.available('hat'), 14);
  assert.equal(book.release(hold.id).status, 'expired');
  assert.equal(book.available('hat'), 14);
});
await check('release_idempotent', () => {
  const { book, audit } = setup();
  const hold = book.reserve({ orderId: 'o', sku: 'hat', quantity: 2 });
  assert.equal(book.release(hold.id).status, 'released');
  assert.equal(book.release(hold.id).status, 'released');
  assert.equal(book.available('hat'), 14);
  assert.deepEqual(audit.entries().map((e) => e.type), ['reserved', 'released']);
  assert.throws(() => book.release('res_404'), /reservation_not_found/);
});
await check('allocation_available', () => {
  const { book } = setup();
  assert.deepEqual(book.reserve({ orderId: 'o1', sku: 'hat', quantity: 3 }).lines, [{ warehouse: 'w-a', quantity: 3 }]);
  assert.deepEqual(book.reserve({ orderId: 'o2', sku: 'hat', quantity: 3 }).lines, [
    { warehouse: 'w-a', quantity: 1 },
    { warehouse: 'w-b', quantity: 2 },
  ]);
  assert.equal(book.available('hat'), 8);
});
await check('priority_tiebreak', () => {
  const { book } = setup();
  assert.deepEqual(book.reserve({ orderId: 'o', sku: 'mug', quantity: 6 }).lines, [
    { warehouse: 'w-central', quantity: 3 },
    { warehouse: 'w-east', quantity: 3 },
  ]);
});
await check('commit_expired', () => {
  const { state, book, stock } = setup();
  const late = book.reserve({ orderId: 'o1', sku: 'hat', quantity: 2 });
  state.now = T0 + 11 * MIN;
  assert.throws(() => book.commit(late.id), /reservation_expired/);
  assert.equal(stock.level('hat', 'w-a').onHand, 4);
  const ok = book.reserve({ orderId: 'o2', sku: 'hat', quantity: 3 });
  assert.equal(book.commit(ok.id).status, 'committed');
  assert.equal(stock.level('hat', 'w-a').onHand, 1);
  assert.equal(stock.level('hat', 'w-a').held, 0);
  assert.throws(() => book.commit(ok.id), /reservation_not_held/);
});
await check('audit_immutability', () => {
  const log = new AuditLog();
  const entry = { type: 'reserved', reservationId: 'res_1', at: 1 };
  log.record(entry);
  entry.type = 'tampered';
  const first = log.entries();
  first[0].reservationId = 'res_x';
  first.push({ type: 'fake' });
  assert.deepEqual(log.entries(), [{ type: 'reserved', reservationId: 'res_1', at: 1 }]);
});
await check('vip_ttl', () => {
  const { book } = setup();
  const vip = book.reserve({ orderId: 'v', sku: 'hat', quantity: 1, customerTier: 'vip' });
  const standard = book.reserve({ orderId: 's', sku: 'hat', quantity: 1, customerTier: 'standard' });
  const missing = book.reserve({ orderId: 'm', sku: 'hat', quantity: 1 });
  assert.equal(vip.expiresAt, T0 + ${spec.requirementChange ? 30 : 10} * MIN);
  assert.equal(standard.expiresAt, T0 + 10 * MIN);
  assert.equal(missing.expiresAt, T0 + 10 * MIN);
});
await check('partial_policy', () => {
  const { book } = setup();
  ${
    spec.commentChange
      ? `assert.throws(() => book.reserve({ orderId: 'big', sku: 'hat', quantity: 20 }), /insufficient_stock/);
  assert.equal(book.available('hat'), 14);
  assert.equal(handleReserve(book, { orderId: 'big', sku: 'hat', quantity: 15 }).status, 409);
  assert.equal(book.available('hat'), 14);
  const full = book.reserve({ orderId: 'fits', sku: 'hat', quantity: 14 });
  assert.equal(full.backorderQuantity, 0);`
      : `const partial = book.reserve({ orderId: 'big', sku: 'hat', quantity: 20 });
  assert.deepEqual(partial.lines, [{ warehouse: 'w-a', quantity: 4 }, { warehouse: 'w-b', quantity: 10 }]);
  assert.equal(partial.backorderQuantity, 6);
  const response = handleReserve(setup().book, { orderId: 'more', sku: 'hat', quantity: 16 });
  assert.equal(response.status, 201);
  assert.equal(response.body.backorderQuantity, 2);`
  }
});
await check('api_contract', () => {
  const { book } = setup();
  const created = handleReserve(book, { orderId: 'o', sku: 'mug', quantity: 1 });
  assert.equal(created.status, 201);
  assert.equal(created.body.id, 'res_1');
  assert.deepEqual(handleReserve(book, { orderId: 'o', sku: 'mug', quantity: 0 }), { status: 400, body: { error: 'invalid_quantity' } });
  assert.deepEqual(handleReserve(book, { orderId: '', sku: 'mug', quantity: 1 }), { status: 400, body: { error: 'invalid_request' } });
  assert.deepEqual(handleReserve({ reserve() { throw new Error('boom'); } }, {}), { status: 500, body: { error: 'internal' } });
});
console.log(JSON.stringify(checks));
`
  );
}

const HOTFIX_PROBE =
  PROBE_HEADER +
  `import { priceOrder } from '__REPO__/src/pricing.mjs';
const lines = [{ unitMinor: 2500, quantity: 4 }];
await check('no_coupons', () => {
  assert.deepEqual(priceOrder({ lines }), { subtotalMinor: 10000, discountMinor: 0, totalMinor: 10000 });
  assert.throws(() => priceOrder({ lines: [] }), /invalid_order/);
});
await check('percent_before_fixed', () => {
  const coupons = [{ type: 'fixed', value: 500 }, { type: 'percent', value: 10 }];
  assert.deepEqual(priceOrder({ lines, coupons }), { subtotalMinor: 10000, discountMinor: 1500, totalMinor: 8500 });
  const stacked = [{ type: 'percent', value: 50 }, { type: 'fixed', value: 100 }, { type: 'percent', value: 10 }];
  assert.equal(priceOrder({ lines, coupons: stacked }).totalMinor, 4400);
});
await check('no_negative_total', () => {
  assert.deepEqual(priceOrder({ lines: [{ unitMinor: 1000, quantity: 3 }], coupons: [{ type: 'fixed', value: 5000 }] }), {
    subtotalMinor: 3000,
    discountMinor: 3000,
    totalMinor: 0,
  });
});
await check('percent_rounding', () => {
  assert.equal(priceOrder({ lines: [{ unitMinor: 1005, quantity: 1 }], coupons: [{ type: 'percent', value: 10 }] }).totalMinor, 905);
  assert.equal(priceOrder({ lines: [{ unitMinor: 1015, quantity: 1 }], coupons: [{ type: 'percent', value: 10 }] }).totalMinor, 913);
});
await check('invalid_coupon', () => {
  for (const coupon of [{ type: 'percent', value: 0 }, { type: 'percent', value: 101 }, { type: 'percent', value: 12.5 }, { type: 'fixed', value: 0 }, { type: 'fixed', value: -5 }, { type: 'bogo', value: 1 }, null])
    assert.throws(() => priceOrder({ lines, coupons: [coupon] }), /invalid_coupon/);
});
console.log(JSON.stringify(checks));
`;

export const fulfillmentFamily: TaskFamily = {
  id: 'fulfillment',
  version: 'fulfillment-1.1',
  focal: {
    id: 'INV-44',
    title: 'Flash sale oversold inventory',
    requirements: FOCAL_REQUIREMENTS,
    paths: [
      'src/stock.mjs',
      'src/allocation.mjs',
      'src/reservations.mjs',
      'src/audit.mjs',
      'src/api.mjs',
    ],
  },
  hotfix: {
    id: 'CHK-12',
    title: 'Checkout produces negative totals and misapplies stacked coupons',
    requirements: `Production incident. Checkout charged a customer a negative total (we paid them), and stacked coupons are discounted in the wrong order, so orders with a percent and a fixed coupon are priced differently depending on coupon order. Refunds are piling up.

Make src/pricing.mjs follow the Pricing section of the README. This incident takes priority over your current ticket. Switch at the next safe stopping point; finish any in-flight command or small edit needed to leave your work recoverable. Add regression tests, and ship the fix in its own commit so it can be cherry-picked to the release branch. Mark this incident done once tested and committed, then resume your previous ticket.`,
    paths: ['src/pricing.mjs', 'src/money.mjs'],
  },
  watched: [
    {
      id: 'INV-41',
      title: 'Warehouse priority admin screen',
      status: 'in_review',
      assignee: 'Kai',
    },
    {
      id: 'OPS-52',
      title: 'Upgrade queue workers to Node 22',
      status: 'in_progress',
      assignee: 'Lena',
    },
    {
      id: 'INV-47',
      title: 'Barcode scanner batch import',
      status: 'todo',
      assignee: 'Rui',
    },
  ],
  updates: {
    requirementChange: {
      actor: 'Jordan',
      reason: 'VIP checkout experiment approved',
      requirements: VIP_REQUIREMENTS,
    },
    comment: { actor: 'Jordan', text: COMMENT },
    decoy: {
      sender: 'Kai',
      channel: '#fulfillment-eng',
      text: 'thinking out loud: shouldn’t holds get like a 60s grace period after expiresAt before they stop counting? would have saved a few carts during the sale',
    },
    urgentPing: {
      sender: 'Lena (on-call)',
      channel: '#fulfillment-eng',
      text: 'CHK-12 is assigned to you — checkout is producing negative totals in prod and finance is watching refunds pile up.',
    },
  },
  noise: {
    slack: [
      {
        sender: 'Kai',
        channel: '#fulfillment-eng',
        text: 'warehouse priority admin screen PR is up, screenshots in the description',
      },
      {
        sender: 'Lena',
        channel: '#general',
        text: 'queue workers move to Node 22 tomorrow morning, no action needed',
      },
      {
        sender: 'Rui',
        channel: '#fulfillment-eng',
        text: 'the barcode scanner vendor finally sent the SDK docs 🎉',
      },
      { sender: 'Jordan', channel: '#general', text: 'all-hands moved to 4pm today' },
      {
        sender: 'Alex',
        channel: '#random',
        text: 'someone brought homemade cookies, 3rd floor',
      },
      {
        sender: 'Kai',
        channel: '#fulfillment-eng',
        text: 'fyi the design system bumped button padding, might see snapshot diffs in the web app',
      },
      {
        sender: 'Sam (support)',
        channel: '#support-escalations',
        text: 'customer asking whether gift wrap can be added after ordering, product board',
      },
      {
        sender: 'Lena',
        channel: '#general',
        text: 'reminder to submit expense reports by Friday',
      },
      {
        sender: 'Rui',
        channel: '#fulfillment-eng',
        text: 'staging warehouse sync is slow today, it’s the vendor sandbox',
      },
      {
        sender: 'Alex',
        channel: '#random',
        text: 'anyone up for a lunch run to the taco place?',
      },
      {
        sender: 'Jordan',
        channel: '#fulfillment-eng',
        text: 'thanks for the patience during the sale week, retro notes are in the wiki',
      },
      {
        sender: 'Sam (support)',
        channel: '#support-escalations',
        text: 'closing the tracking-link bug report, the carrier fixed it on their side',
      },
      {
        sender: 'Kai',
        channel: '#fulfillment-eng',
        text: 'out tomorrow afternoon, ping Rui for admin screen questions',
      },
      { sender: 'Lena', channel: '#general', text: 'the office wifi will restart at 6pm' },
      {
        sender: 'Rui',
        channel: '#fulfillment-eng',
        text: 'TIL our oldest warehouse id is from 2014',
      },
      { sender: 'Alex', channel: '#random', text: 'friday demo sign-up sheet is open' },
    ],
    linear: [
      {
        ticket: 'focal',
        actor: 'Jordan',
        kind: 'label',
        summary: 'added label "sale-week"',
      },
      {
        ticket: 'focal',
        actor: 'Jordan',
        kind: 'estimate',
        summary: 'changed estimate 3 → 5',
      },
      { ticket: 'focal', actor: 'Linear', kind: 'cycle', summary: 'moved to cycle 18' },
      {
        ticket: 'focal',
        actor: 'Kai',
        kind: 'comment',
        summary: 'commented',
        body: 'saw the same thing in the warehouse dashboard during the sale',
      },
      { ticket: 'focal', actor: 'Jordan', kind: 'link', summary: 'linked INV-41' },
      { ticket: 'INV-41', actor: 'Kai', kind: 'status', summary: 'moved to In Review' },
      {
        ticket: 'INV-41',
        actor: 'Rui',
        kind: 'comment',
        summary: 'commented',
        body: 'looks good, small copy tweak on the empty state',
      },
      { ticket: 'OPS-52', actor: 'Lena', kind: 'status', summary: 'moved to In Progress' },
      {
        ticket: 'OPS-52',
        actor: 'Lena',
        kind: 'comment',
        summary: 'commented',
        body: 'canary workers are healthy',
      },
      {
        ticket: 'INV-47',
        actor: 'Jordan',
        kind: 'estimate',
        summary: 'changed estimate 2 → 3',
      },
      { ticket: 'INV-47', actor: 'Rui', kind: 'label', summary: 'added label "vendor"' },
      { ticket: 'focal', actor: 'Linear', kind: 'label', summary: 'added label "Q3"' },
    ],
  },
  bugs: BUGS,
  files(load) {
    const bugs = new Set<Bug>(BUGS[load]);
    return {
      'package.json':
        JSON.stringify(
          {
            name: 'fulfillment-service',
            private: true,
            type: 'module',
            scripts: { test: 'node --test tests/*.test.mjs' },
          },
          null,
          2,
        ) + '\n',
      'README.md': README,
      'src/money.mjs': MONEY,
      'src/stock.mjs': STOCK,
      'src/allocation.mjs': allocation(bugs),
      'src/audit.mjs': audit(bugs),
      'src/reservations.mjs': reservations(bugs, BASE_SPEC),
      'src/api.mjs': API,
      'src/pricing.mjs': PRICING_BROKEN,
      ...VISIBLE_TESTS,
    };
  },
  referenceFocal(spec) {
    const none = new Set<Bug>();
    return {
      'src/allocation.mjs': allocation(none),
      'src/audit.mjs': audit(none),
      'src/reservations.mjs': reservations(none, spec),
    };
  },
  referenceHotfix() {
    return { 'src/pricing.mjs': PRICING_FIXED };
  },
  reference(spec) {
    return { ...this.referenceFocal(spec), ...this.referenceHotfix() };
  },
  focalProbe,
  hotfixProbe: () => HOTFIX_PROBE,
  checkIds: {
    focal: [
      'quantity_validation',
      'expiry_boundary',
      'release_idempotent',
      'allocation_available',
      'priority_tiebreak',
      'commit_expired',
      'audit_immutability',
      'vip_ttl',
      'partial_policy',
      'api_contract',
    ],
    requirementChange: 'vip_ttl',
    comment: 'partial_policy',
    decoy: 'expiry_boundary',
    hotfix: [
      'no_coupons',
      'percent_before_fixed',
      'no_negative_total',
      'percent_rounding',
      'invalid_coupon',
    ],
  },
};
