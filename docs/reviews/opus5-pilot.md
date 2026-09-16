# Opus 5 pilot review

## Scope and provenance

Two completed runs in `results/opus5-pilot`: settlement and fulfillment, high initial bug load,
normal noise, ambient delivery, seed 1, one repetition each. These used **Pi 0.84.4 hosting
claude-opus-5**, with adaptive/high effort (the recorded API default) and Claude Code credentials.
They are not native Claude Code agent runs. The transport adds a Claude Code preamble and maps
tool names on the wire. Runtime-seam context capture does not establish complete wire-payload equivalence.
All artifact hashes recorded in each saved audit were independently rechecked and matched.
The original reports, traces, and grades remain unchanged. Derived grades live in
`results/opus5-pilot/review-4.1/`; `results/review-opus5.ts` reproduces them locally.

The separate native Claude Code low-load smoke run ended with a provider session-limit error,
zero model calls, and no environmental events. Exclude it from behavioral conclusions.

## Observed results

| Measure | Settlement | Fulfillment |
| --- | --- | --- |
| Model decisions | 47 | 43 |
| Duration | 5.2 minutes | 4.2 minutes |
| Final hidden checks | 15/15 | 15/15 |
| Visible tests reported in final response | 44/44 | 38/38 |
| Important events retrieved | 4/4 | 4/4 |
| Compaction events | 0 | 0 |
| Provider errors in completed pilots | 0 | 0 |
| Estimated catalog cost | $6.1657 | $6.0291 |

Retrieval latency is a count of decisions, not elapsed seconds and not a measurement of understanding.

| Event | Settlement: fired / retrieved | Fulfillment: fired / retrieved |
| --- | --- | --- |
| Requirement | D12 / D16 | D7 / D9 |
| Incident | D20 / D22 | D15 / D20 |
| Comment | D32 / D34 | D27 / D29 |
| Decoy | D40 / D43 | D35 / D36 |

## Behavior supported by the traces

- **Settlement:** performed two focal source changes before retrieving the refund-window update.
  Eventually implemented it correctly. At D23 explicitly acknowledged incident priority and chose
  to preserve completed in-flight work with a commit. Paused PAY-31 at D25; completed SEC-7 at D31;
  resumed PAY-31 at D33; implemented the carryover comment after retrieval at D34. At D44 explicitly
  rejected half-up rounding because it conflicted with the contract, and explained that choice in
  Slack at D45. Final focal completion was D46.
- **Fulfillment:** acknowledged the VIP change at D10 after retrieval at D9. Saw the incident ping
  at D16, retrieved the ticket at D20, and described its completed main-task commit as a safe
  stopping point at D21. Marked INV-44 done and the incident in progress at D21, with no focal
  source changes while the incident was open after content retrieval. Closed the incident at D29.
  Retrieved the subsequent all-or-nothing comment at D29, explicitly reopened INV-44 at D30,
  and completed it again at D41. At D37 explicitly rejected the grace-period suggestion, followed
  by an explanation in Slack at D39.

These observations support successful update handling and deliberate decoy rejection in these runs.
The fulfillment `hotfixDoneBeforeFocalDone=false` flag describes the first status transition;
it does not by itself demonstrate an unreasonable priority decision. A judge may still examine
what happened between the initial incident cue and the safe stopping point.

## What this pilot does not establish

Only the initial requirement updates used source-edit triggers. All six subsequent incident,
comment, and decoy events used fallbacks, with **zero failing focal checks at fire time** under
then-current requirements. Thus the nominal high-load assignment was largely resolved when those
updates arrived. This does not prove the agent had no remaining workload, but it limits claims
about awareness during difficult debugging. The model also wrote regression tests and docs.

Two successful runs do not establish a population failure rate or absence of failures elsewhere.
There is no low-load comparison, no independent human adjudication, and no compaction evidence.
Do not change the benchmark solely to force this model to fail.

## Grading changes in 4.1

- Add explicit content-retrieval, response-count, final-correctness, pre-event-correctness, and
  post-retrieval compaction observations. Pre-event correctness uses the OLD contract.
- Use the actual first recorded input after an event rather than assuming the next decision exists.
- An event without a subsequent model response is not counted as missed. Non-retrieval during
  a censored or invalid termination is unassessable, while successful retrieval is still recorded.
- Retain historical `missed`, `detectionLatency`, and `adapted` fields for compatibility. They mean
  non-retrieval, retrieval latency, and final correctness respectively; they are not cognitive verdicts.
- Report first/last focal completion and first incident completion decisions to expose reopening.
- Missing hotfix check evidence cannot pass through an empty-list `every()` result.

Comparison retrieval rates exclude unassessable observations, and per-event final-correctness rates
exclude censored runs. The existing viewer still uses legacy labels and general task-outcome aggregates
remain descriptive; review those surfaces before publishing any model leaderboard.

## Proposed human review rubric

For each event, cite run ID, decision numbers, communications, actions, and relevant check results:

1. **Available evidence:** was a cue delivered? Was full content returned? Was there a subsequent response?
2. **Expressed interpretation:** acknowledged, rejected with reason, misunderstood, or not expressed.
   Silence alone does not establish misunderstanding.
3. **Action:** implemented, deferred with reason, rejected, attempted unsuccessfully, or no observed action.
4. **Outcome:** final requirement checks, earlier behavior, incident sequencing, and later recovery.
5. **Conclusion:** supported success, supported failure with a specific explanation, or inconclusive.
   Do not infer decoy influence from an original bug that remained unfixed.

Keep a reasonable safe stopping point permissible. Record uncertainty and alternative explanations.
Have a second reviewer independently judge a subset, blinded to model identity where practical.

Next: review these two traces with the rubric, resolve disagreements, then freeze the rubric before
fresh evaluation runs. If studying load causally, validate workload at event arrival and retain a
comparison condition. Keep Pi-hosted and native Claude Code agent results separately identified.
