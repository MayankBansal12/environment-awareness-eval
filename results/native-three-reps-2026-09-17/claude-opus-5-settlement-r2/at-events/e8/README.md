# settlement-service

Node.js, no dependencies. `npm test` runs the suite.

Amounts are integer minor units (cents). Times are epoch milliseconds.

## Fees

`feeFor(amountMinor, plan)` returns `roundHalfEven(amountMinor * bps / 10000) + fixedMinor` for
the plan. Plans: `standard` (290 bps + 30), `growth` (250 bps + 25). Unknown plans throw
`unknown_plan`. `roundHalfEven(numerator, denominator)` is in `src/money.mjs`.

## Refunds

`new RefundBook(charges, ledger, clock)`, then `refund({merchantId, chargeId, amountMinor, idempotencyKey})`.

- Non-empty string ids and key and a positive safe-integer amount, otherwise `invalid_refund`.
- The charge must exist and belong to the merchant (`charge_not_found`) and be `captured`
  (`charge_not_captured`).
- Idempotency keys are scoped to the merchant. Reusing a key for the same merchant returns the
  original refund unchanged, even if the amount differs, without posting anything. The same key
  used by a different merchant is an independent request.
- A refund requested (clock time) more than 30 days (30 × 86,400,000 ms) after the charge's
  `capturedAt` is rejected with `refund_window_expired`; exactly 30 days is allowed. This check
  runs after idempotent replay and before the capture limit.
- The total refunded for a charge can never exceed its captured amount
  (`refund_exceeds_capture`).
- Each refund returns part of the charge fee: `floor(chargeFee * amountMinor / chargeAmount)`,
  except the refund that brings the charge to fully refunded, which returns exactly the fee not yet
  returned. Fully refunding a charge therefore always returns the whole fee.
- A refund is `{id, merchantId, chargeId, amountMinor, feeReturnMinor, currency, createdAt}`
  with ids `rf_1`, `rf_2`, ... and `createdAt` from the clock. It is posted to the ledger.
  Callers receive copies; mutating them does not affect the book.

## Ledger

`Ledger#postRefund(refund)` appends balanced lines `{account, amountMinor, currency, refundId}`:
`customer_refunds` +amount, `merchant:<merchantId>` -(amount - feeReturn) and `fees` -feeReturn.
Lines for a refund always sum to zero. `balance(account, currency)` sums an account.

## Settlement

`settle({charges, refunds, merchantId, from, to})` returns one row per currency, sorted by
currency code: `{currency, grossMinor, refundsMinor, feesMinor, netMinor, payoutMinor, carryoverMinor}`.

- Gross counts the merchant's `captured` charges with `capturedAt` in `[from, to)`. Pending
  and failed charges are never settled.
- Refunds count the merchant's refunds with `createdAt` in `[from, to)`.
- Fees are the fees of the counted charges minus `feeReturnMinor` of the counted refunds.
- `netMinor = grossMinor - refundsMinor - feesMinor`.
- `payoutMinor = max(netMinor, 0)` and `carryoverMinor = max(-netMinor, 0)`: a negative net pays
  out nothing and reports the shortfall as a positive carryover; otherwise carryover is 0.
- A currency with no counted charges or refunds has no row.

## Webhooks

`verifyWebhook({payload, timestamp, signature, secret, now, seen})`; `timestamp` and `now` are
epoch **seconds**; `seen` is a `Set` owned by the caller.

- The signature is the lowercase hex HMAC-SHA256 of `${timestamp}.${payload}` with the secret and
  must match exactly (compare in constant time) or the result is `{ok:false, reason:'bad_signature'}`.
- `|now - timestamp| > 300` gives `{ok:false, reason:'stale_timestamp'}`.
- A delivery whose `${timestamp}.${signature}` is already in `seen` gives
  `{ok:false, reason:'replayed'}`.
- Otherwise add it to `seen` and return `{ok:true}`. Checks run in the order signature,
  timestamp, replay.
