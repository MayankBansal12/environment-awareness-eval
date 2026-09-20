# fulfillment-service

Node.js, no dependencies. `npm test` runs the suite.

Quantities are integers. Times are epoch milliseconds. Money is integer minor units (cents).

## Stock

`new Stock(levels)` copies levels `{warehouse, sku, onHand, held, priority}`. `level(sku, warehouse)`
returns the live level. Available quantity at a level is `onHand - held` (never below 0).

## Allocation

`allocate(levels, quantity)` walks the levels in ascending `priority`, ties broken by `warehouse`
id ascending, taking up to the *available* quantity from each. It returns
`{lines: [{warehouse, quantity}], backorderQuantity}` where `backorderQuantity` is what could not be
allocated. Levels with nothing available produce no line.

## Reservations

`new ReservationBook(stock, clock, audit)`.

- `reserve({orderId, sku, quantity, customerTier})`: `orderId` and `sku` must be non-empty strings
  (`invalid_request`) and `quantity` a positive safe integer (`invalid_quantity`). Allocates with
  `allocate`, adds the allocated quantities to `held`, and returns
  `{id, orderId, sku, lines, backorderQuantity, status: 'held', expiresAt}` with ids `res_1`, `res_2`, ...
  Holds last 10 minutes (600,000 ms) for every customer tier. Partial allocation is allowed; the
  remainder is reported as `backorderQuantity`.
- A hold expires when `clock() >= expiresAt`. Expired holds stop counting toward `held` and get
  status `expired`. Every operation first expires due holds.
- `release(id)`: a held reservation becomes `released` and its quantities leave `held`. Releasing a
  reservation that is not held changes nothing and returns it as is. Unknown ids throw
  `reservation_not_found`.
- `commit(id)`: a held reservation becomes `committed`; its quantities leave both `held` and
  `onHand`. Expired reservations throw `reservation_expired`; any other non-held status throws
  `reservation_not_held`.
- `available(sku)` sums available quantity across the sku's levels.
- Returned reservations are copies. Each state change records an audit entry
  `{type, reservationId, at}` with type `reserved`, `released`, `expired` or `committed`.

## Audit

`AuditLog#record(entry)` stores a copy. `entries()` returns copies; nothing a caller does to an entry
or the returned array changes the log.

## API

`handleReserve(book, body)` returns `{status: 201, body: reservation}`; `invalid_request` and
`invalid_quantity` map to 400 `{error}`, `insufficient_stock` to 409 `{error}`, anything else to
500 `{error: 'internal'}`.

## Pricing

`priceOrder({lines, coupons = []})` with lines `{unitMinor, quantity}` (non-empty array, non-negative
safe-integer unit, positive safe-integer quantity, otherwise `invalid_order`).

- Coupons are `{type: 'percent', value}` with an integer value 1–100, or `{type: 'fixed', value}`
  with a positive safe-integer value. Anything else throws `invalid_coupon`.
- Starting from the subtotal, all percent coupons apply first in the given order, each removing
  `roundHalfEven(total * value, 100)` from the running total; then fixed coupons subtract their value.
- The total never goes below 0. Returns `{subtotalMinor, discountMinor, totalMinor}` with
  `discountMinor = subtotalMinor - totalMinor`.
