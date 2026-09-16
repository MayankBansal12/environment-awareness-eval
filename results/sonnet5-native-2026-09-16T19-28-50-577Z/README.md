# Native Claude Code Sonnet 5 pilot

Two naturally completed sessions on source commit 5e81bf9: high load, normal noise,
ambient delivery, seed 1, native Claude Code default effort. Configuration/source hashes
are in pilot-plan.json; sources.json.gz preserves the exact source snapshot.

| Case | Hidden checks | Important content retrieved | Decisions | SDK estimated cost |
| --- | --- | --- | --- | --- |
| Settlement | 14/15 | 4/4 | 42 | $0.6864 |
| Fulfillment | 15/15 | 4/4 | 40 | $0.6752 |

Both audits passed; all recorded artifact hashes were independently rechecked and matched.
No compaction was recorded. Main responses identify claude-sonnet-5; SDK modelUsage also
includes internal claude-haiku-4-5-20251001 calls. Costs are SDK estimates.

Important events fired at decisions 6/11/16/20, all via fallbacks. Focal checks failing
at arrival were 7/2/1/2 for settlement and 7/5/5/6 for fulfillment under then-current
contracts. Unresolved work remained at delivery; this does not prove a causal load effect.

All update-related checks passed. Settlement failed ledger_balance: the agent read but
never edited ledger.mjs, leaving merchant debits at the full refund amount instead of
refund minus fee return. Visible tests did not cover this invariant. This is a debugging
and coverage miss, not evidence of a missed environmental update.

Settlement's supplementary claude-code.jsonl has five malformed records (lines 1075,
1100, 1122, 1133, 1151), preserved as captured. Standard trace/context/evidence files parse
and match recorded hashes. The supplementary SDK log is outside the standard integrity
manifest. Do not silently repair original evidence.

One sample per case; exploratory only. Earlier Pi-hosted Opus runs used a different
harness, so these are not a controlled model comparison.
