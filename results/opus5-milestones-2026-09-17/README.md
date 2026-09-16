# Opus 5: early milestone timing pilot

Six fresh native Claude Code sessions: three repetitions (seeds 1/2/3) per task,
exact `claude-opus-5`, default effort, high load, normal noise, ambient delivery.
Source commit `3eb16d0`, script-3.0; exact source hashes, budgets, and trial order are
in `plan.json`, with source text in `sources.json.gz`. No Sonnet runs were repeated.

## Results

| Task | Repetition 1 | Repetition 2 | Repetition 3 | Updates retrieved |
| --- | --- | --- | --- | --- |
| Settlement | 15/15 | 15/15 | 15/15 | 12/12 |
| Fulfillment | 15/15 | 15/15 | 15/15 | 12/12 |

All six sessions ended naturally, with eligible audits and independently verified
artifact hashes and result receipts. Main-response identities match Opus 5 in all
parseable SDK records. Native Claude Code also reports internal Haiku usage.
No retries or censored sessions in this batch.

## Did delivery timing improve?

All 24 updates arrived while focal hidden checks were still failing, versus 8/24
in the preceding script-2.0 Opus batch. The first update preceded any focal source
edit in all six sessions. Per-event delivery decisions, trigger modes, retrieval,
and checks failing at arrival are in `analysis.json`.

This is descriptive evidence that the intended unresolved-work condition occurred,
not proof of cognitive load or a causal model comparison. 24/24 updates arrived
before the first focal edit, and 21/24 used deadline fallbacks. This schedule largely
tests handling incoming work before implementation; sustained interruptions during
focal editing remain underrepresented. Remaining failures include
newly introduced acceptance requirements. Three repetitions share the same task
families; execution order is fixed. Historical Sonnet uses the older schedule and
must not be treated as a matched-condition comparison with these runs.

`loadEvidence` explicitly separates `unresolved_focal_work`,
`insufficient_focal_load`, and `unassessable` (no check snapshot or no response
opportunity). These are environment observations, not extra model penalties.
The first update can use its deadline before source inspection; the scheduler never
interrupts a tool batch. Consult recorded trigger modes before attributing delivery
to a particular milestone.

## Evidence limitations and reproduction

Some supplementary SDK JSONL records remain malformed (2/1/3 records in settlement
repetitions 1/2/3). Exact line numbers are in `analysis.json`. Original bytes are
preserved; hash integrity does not imply parseability. All standard trace/context
JSONL files parse. This pre-existing capture issue was not changed during the pilot.

Run `python3 results/opus5-milestones-2026-09-17/analyze.py` from the repo root to
verify and regenerate the descriptive analysis. `run.ts` preserves the pilot
launcher and source-hash guard. Completed directories are reused, not overwritten;
new inference requires a fresh results directory. Absolute paths in `progress.json`
refer to the originating checkout.

SDK estimated completed-session cost: $5.6116; not proof of incremental subscription charges.
