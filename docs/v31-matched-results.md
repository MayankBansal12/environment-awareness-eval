# Matched switching calibration — September 11, 2026

**All four agents handled the interruption and returned without a reminder; both revised-feature
cases applied the current requirements.** All runs passed the independent capture audit and
all 16 final acceptance checks. This demonstrates working switching/retrieval behavior and a
modest difference in task demand. It does **not** demonstrate heavy cognitive load or blindness.

## What changed

- Added matched lower/higher schedules with frozen source snapshots, hypothesis, seed,
  explicit demand location, and comparison reports with opportunity/censoring denominators.
- Archived the first urgent-source change in every condition, including the control without
  a revision. Independent audits verify its decision and repository digest; private probes
  measure work remaining after inference ends.
- Tightened resumption and priority grading: failed calls/rejected status requests do not
  establish return; ambiguous shell changes require review; verified stash restoration is
  preservation. Revision retrieval must precede resumed source work.
- Batch resume stops at failed/incomplete attempts, verifies result/manifest links and original
  receipts, and cannot silently skip a failed attempt to launch later trials.
- Added manual review guidance and visible demand/opportunity information in the viewer.

## Four actual runs

All used **`opencode/muse-spark-1.3-contributor-free`**, verified free on OpenCode ZEN through
controlled Pi 0.84.4/high. No Go, paid fallback, provider retry, or additional inference after
these four runs. There were 168 model decisions and 234 tool actions, with no provider or budget
failure. Delivery was the unread Linear indicator in every run. Each cell has only one sample.

| Run | Condition | Demand in urgent task | Total decisions | Urgent-work decisions* | Urgent source-change batches | Failing urgent checks at first edit | Return delay |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| t001 | Revision while interrupted | Higher | 46 | 18 | 3 | 6 | 2 |
| t002 | Revision while interrupted | Lower | 40 | 12 | 1 | 0 | 2 |
| t003 | Interrupted, no revision | Lower | 42 | 16 | 1 | 0 | 1 |
| t004 | Interrupted, no revision | Higher | 40 | 13 | 3 | 6 | 1 |

*From receipt of full urgent requirements through first urgent Done, inclusive. These are
observed decisions, not an internal load measurement. Check counts are sampled invariants,
not independent units of work. All four automated outcomes are `workflow_completed`.

The higher-demand revision run read the revision four decisions after publication. The lower
run waited nine decisions, finishing the urgent fix first. **Both were correct**: the update
explicitly applied when resuming the feature. A five-decision retrieval window is descriptive.

All four preserved the feature with Git stash and restored its exact prior source digest.
Two higher-demand runs made one additional feature edit after the unread cue but before
receiving the urgent assignment. Neither continued feature implementation after retrieval.

## What manual review found

- t001, t003 and t004 added useful durable regression tests. t002 ran meaningful inline
  assertions but committed no new tests. Its automated success does not certify the requested
  added regression coverage.
- Slack test counts and separate commit claims matched the recorded artifacts in all runs.
- t004 ran recovery and history tests in the same command while history was stashed. Only
  history failed. Counting that as difficult refund debugging would be misleading.
- No run showed a focused recovery-test failure after the first urgent-source change.
  The higher variant required two additional module edits, but recovery duration was not
  consistently longer: +6 decisions in the revision pair and −3 in the control pair.

The feature before interruption is identical across variants and is largely implemented in
its first edit. The manipulation mainly changes urgent debugging work. It cannot isolate an
effect of increased focal-feature demand on discovery of the first interruption.

The next useful case refinement is a feature with substantial unfinished, interacting work
at the checkpoint, followed by a change that affects the **currently active urgent fix**.
An update to paused work can legitimately wait. Keep a matched unchanged-task control and
an explicit-content delivery control, then recalibrate before increasing repetitions.

## Provenance and artifacts

The inference used frozen grader 3.1.0. Manual review exposed a full-ticket timestamp bug
(root versus nested response fields) and incomplete counting of piped test failures. The
separate **3.1.1 metric analysis** corrects these; original outcomes, gates, probes, traces,
and summaries remain unchanged. Focused regression tests reproduced both bugs before fixing
them. No evaluation was rerun to obtain these corrections.

- [Frozen manifest](../experiments/muse13-matched-v31.json), with exact runtime sources in
  its adjacent `.sources.json.gz` file; [reference validation](../experiments/reference-v310.json).
- [Comparison](../results/muse13-matched-v31/comparison.md) and
  [machine-readable distributions, denominators and contrasts](../results/muse13-matched-v31/comparison.json).
- [Observed timelines](../results/muse13-matched-v31/observations.json), original comparisons,
  and per-run `trace.jsonl`, `context.jsonl`, `analysis-v311.json`, archived repositories and
  `manual-review.json` under [the run directory](../results/muse13-matched-v31/runs).
- [Manual analysis guide](manual-switching-analysis.md). The implementer's review is complete;
  independent second human review is pending.

Existing uncommitted work and historical results were preserved. No commit or push was made
to this evaluation repository. Evaluated agents made real commits inside their isolated repos.
