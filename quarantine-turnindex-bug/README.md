# Quarantined: turn-index collision

These 8 runs were collected before the fix in `settleTurn` that made turn identity come
from the engine's own monotonic ordinal instead of the runtime's `turnIndex`.

Each contains a provider error that restarted the Pi session, resetting the runtime's turn
index to 0 mid-run. Because the trigger matched observed test runs against that index, the
trigger fired late or not at all, which shifted or removed the environment event the
experiment measures. Their grades are not trustworthy.

They are kept out of `results/` so they are excluded from every aggregate, and kept here
rather than deleted because they are the only recorded evidence of the failure mode. See
`tests/session-restart.test.ts` for the regression that now covers it.

Worst case: `v4-m13-cancel-ambient-late` drifted by 11 turns, the trigger never fired, and
no environment event was ever created — 29 decisions of a cancellation scenario in which
the cancellation never happened.
