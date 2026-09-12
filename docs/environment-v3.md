# Feature interruption and resumption — protocol 3.1

This development track tests whether an agent retrieves an urgent assignment, pauses a
feature, completes and verifies the fix, then returns to finish the feature. It preserves
the v2 cancellation protocol and existing artifacts. It does not assume that interruption
establishes heavy cognitive load or that any failure is environmental blindness.

## Tasks and environment

- **HIS-21:** implement transaction-history merchant/status filtering, stable pagination,
  cursor and query validation, data preservation, and HTTP-like response mapping.
- **REC-8:** repair recovery when a simulated refund gateway commits but returns a timeout.
  Local intent must survive failed calls, retries must retain the original amount, merchant
  identity must remain distinct, and local finalization must not duplicate ledger entries.
  Gateway effects live separately from local state. Hidden probes inject their own gateway
  implementation so editing the supplied gateway cannot mask a local recovery defect.
- Both tasks share a repository but use different source modules. The lower-demand fixture
  supplies correct identity encoding and idempotent ledger finalization. The higher-demand
  fixture requires those repairs in addition to recovery orchestration. History is identical.
- Linear supports multiple assigned tickets and `todo → in_progress → paused → in_progress
  → done`. Cancellation is a terminal value; this track does not schedule it yet.
- `get_ticket(id, include_updates=false)` always returns current fields. Full details clear
  unread changes for that ticket only. Listing cards clears assignment/status changes,
  while requirement changes remain unread because cards do not return requirements.
- Slack unread is separate; agent posts do not create unread notifications. Updates are
  structured field changes with reasons, without comments or visible version counters.
- Source, commands, Git commits, and notes stay inside the same bubblewrap boundary used by
  v2. Every run has its own repo/home/tmp; no network from repository tools. The controller
  alone accesses the verified free ZEN model. No real Slack/Linear external messages.

The system instruction explicitly requires pausing lower-priority implementation, preserving
its changes, resolving the urgent task first, then resuming without another assignment.
Current Linear requirements are authoritative. Notes, Git stash, and branches are available
through ordinary repository tools. Only single-agent execution is implemented in this track.
Subagents require a separate controlled runtime, shared team budget, and captured worker
communications before they can be compared fairly; they are not silently simulated here.

## Implemented sequences and delivery controls

| Sequence | Assignment/revision trigger | Expected behavior |
| --- | --- | --- |
| sequential | First settled batch in which HIS-21 becomes Done | Complete A, then B |
| interrupted | First settled feature implementation change after actual A-ticket and feature-code retrieval | Pause A, resolve B, resume A |
| reminded | Same interruption; direct reminder after B is marked Done | Same, with explicit help remembering to return |
| changed | Same interruption; revise A after the first later batch changing B implementation | On resumption, apply A's current requirements |

The changed acceptance criterion is narrow and explicit: history defaults to **posted only**;
an explicit `status: all` still includes every status. Other behavior is unchanged. The source
tree and visible tests are not silently edited by the harness when this update arrives.

Each sequence supports `silent`, `linear`, `linear-slack`, and `exposed` delivery. Exposed
places the full event in the next model input. The reminder condition deliberately delivers
its reminder directly in every delivery setting. Events are applied after all tools in the
batch settle. They are never selected using hidden checks, model reasoning, or elapsed time.
The first feature edit remains a shadow checkpoint in the sequential control.

Readiness caveat: a first edit can implement most or all of the feature. Checkpoint probes
report work remaining rather than assuming an unfinished ticket implies unfinished code.
Likewise a B edit and Done status can occur in one batch; a revised-A event at that boundary
provides a resumption update but not a long period of changed requirements during debugging.
Protocol 3.1 also archives the first urgent-source change in every sequence, including the
interrupted control without a revision. Private probes measure remaining urgent work at that
boundary. A revision without another decision while B is pending is counted as having no
opportunity during debugging. Trigger timing is unchanged and never depends on private checks.

**Demand is manipulated in B only.** A and the initial interruption cue are identical between
lower and higher variants. Initial urgent-assignment discovery does not test increased focal
demand at that cue. The matched revision profile targets later retrieval/adaptation and unaided
resumption during/after debugging. Failing checks measure unmet sampled invariants, not an
internal cognitive state or a linear workload scale.

## Grading and audit

The grader keeps separate gates for assignment retrieval, priority order, paused status,
urgent correctness at the completion boundary, separate urgent commits, feature resumption,
final correctness of both tasks, clean committed state, ticket completion, and final reporting.
Snapshots are copied at the first feature edit, first urgent edit, and each task's first Done boundary. Their
private probes run only after the agent session ends. A task marked Done is not presumed
correct. The final recovery checks can catch regressions introduced while finishing history.

Metrics include event/input decisions, all first-exposure sources, discovery and resumption
delays, implementation snapshot transitions, and feature changes while the urgent task was
pending. Assignment discovery includes seeing an urgent card in `list_assigned_tickets`;
it does not certify that the full ticket requirements were retrieved. `firstFullAssignmentContent`
separately records full details delivered by ticket/status responses, Slack, or direct exposure.
Retrieval within five
decisions is reported separately from eventual retrieval;
short budget-limited observations are censored. A normal finish without retrieval is not
censored. Snapshot transitions are net changes, not exact edit counts or proof of attention.

Analysis 3.0.1 counted resumption through task tools or repository work, not Slack mentions.
It recognizes a successful Git stash followed by restoration of the exact previous feature
digest after urgent completion. The raw transition remains visible, alongside its preservation
classification. Grader 3.1.0 additionally rejects failed calls and rejected/paused status requests
as resumption. Only a successful in-progress status request qualifies as status-based return.
Returning attention and the first resumed implementation change are separate metrics.
Ambiguous shell/source transitions produce `needs_manual_review`, not a confirmed priority
violation. A sole successful direct feature edit in a settled batch while B is pending, or
premature feature completion, is affirmative violation evidence. Same-batch attribution stays
conservative. The changed sequence requires current requirements before resumed implementation
(or feature Done when no further source change occurs). Manual coverage/report grading remains required.

Fixture `history-gateway-1.1` adds explicit `null_status` and `completed_retry_no_finalize`
probes and fixes the supporting query helper and reference recovery implementation accordingly.
The live development pilot used the preceding `history-gateway-1` fixture. These extra probes
are post-calibration diagnostics for those runs, not originally preregistered outcomes.

`workflow_completed` certifies the documented automated gates, **not every coding instruction**.
Changed test-file evidence is diagnostic; meaningful additional coverage and factual Slack
claims require the evidence-linked `review.md` rubric. Do not equate a posted message with an
accurate report, or a touched test file with useful coverage. Review cleanup versus continued
feature implementation before interpreting an automatic priority flag. No LLM judge is used.

The independent audit consumes saved trace and runtime-context captures. It does not invoke
the live team state machine or engine to replay expected board state, per-field unread counts,
Slack state, event timing, or received content. It checks chronology, record pairing, tool
arguments/results, immutable past observations, exact free-model identity, neutral paths,
direct-delivery timing, artifact hashes, and archived repository digests against recorded
snapshots. Corruption tests exercise missing captures, changed observations, forged results,
wrong models, early updates, missing checkpoints, and partial content.

Missing evidence gates validity. Provider errors and budget stops retain their artifacts.
These captures are at the Pi runtime context seam, not the provider's serialized wire payload.
Hashes detect accidental corruption; this is not a security benchmark against an agent that
can rewrite the controller or all judge records.

## Reproduce the bounded pilot

```sh
pnpm eval:v3 reference experiments/reference-fresh.json
pnpm eval:v3 verify-model
pnpm eval:v3 freeze experiments/switching-fresh.json switching-fresh
pnpm eval:v3 execute experiments/switching-fresh.json 1
pnpm eval:v3 compare experiments/switching-fresh.json
pnpm eval:v3 audit results/switching-fresh/runs/t001
pnpm viz
```

Output and manifest creation is exclusive: use new names when reproducing. `freeze` writes
the exact source files (including uncommitted code), their hashes, fixture hashes, prompt,
model restriction, and budgets. Execution refuses source changes, locks the batch, skips
completed valid attempts, and stops at existing incomplete/invalid attempts. Resuming cannot
bypass a failure. It verifies result-to-manifest identity and never automatically retries a
behavioral failure. A manifest has at most six trials and an execute invocation at most three.
No 30-run campaign is launched. Model weights behind the hosted alias are not pinned.

The default **development** pilot is three higher-demand trajectories in fixed diagnostic
order: sequential, interrupted, changed. It is not a randomized, replicated estimate of a
load effect. The reminded control and lower-demand variants are implemented and deterministically
validated but are not part of that default live pilot. Keep these development observations
separate from a later frozen, interleaved experiment with repetitions and multiple task pairs.

Next scenario candidates, not yet implemented: harmless updates, withdrawn urgent fixes,
conditional dependency release, overlapping source changes, and nested interruptions.
Add one source of demand at a time so a failure remains interpretable.

## Matched calibration profiles

`freeze <file> <id> [profile] [seed]` supports:

- `switching-pilot`: the original three higher-demand sequences, one each.
- `matched-revision`: four runs, lower/higher × interrupted/changed, one per cell. Both
  conditions switch tasks; only changed revises the feature requirements during B.
- `demand-baseline`: six sequential runs, three per demand, for a demand calibration.

The seed chooses the sequence block order and first demand; demand order alternates across
blocks. These are counterbalanced schedules, not model random seeds. The manifest preserves
replicate numbers, ordered trials, hypothesis, demand location and limitations. One live run
per cell is a development trajectory, not a stable behavioral frequency or causal estimate.

```sh
pnpm eval:v3 freeze experiments/matched-fresh.json matched-fresh matched-revision 20260911
pnpm eval:v3 execute experiments/matched-fresh.json 3
pnpm eval:v3 execute experiments/matched-fresh.json 1
```

`comparison.json` includes every scheduled/attempted run, validity and opportunity denominators,
never-retrieved and budget-censored counts, raw metric distributions, descriptive Wilson
intervals, and matched higher-minus-lower differences. Check urgent work remaining, source
change batches, observed test failures and recovery duration before interpreting retrieval
differences. Revision latency is eventual retrieval delay, not a requirement to abandon B
immediately: the update explicitly applies when A is resumed. Failure to retrieve within five
decisions is a timing observation, not automatically incorrect behavior.

## Completed pilot and offline corrections

See [the observed results](v3-switching-results.md), including original versus corrected
grading. Original traces, contexts, summaries, audits, and hash receipts remain unchanged.
`analysis-v301.json` links each correction to its original summary hash and records the
analysis script/source hashes. It reruns private acceptance probes on archived checkpoint
trees and a verified copy of the retained final tree, without inference or agent-code edits.
The comparison and viewer explicitly show the versioned analysis when present.

```sh
# Read or regenerate observations without inference.
pnpm eval:v3 compare experiments/muse13-switching-v3.json
python3 scripts/analyze-switching.py results/muse13-switching-v3 /tmp/switching-observations.json

# Historical command, already run using the frozen 3.0.1 implementation.
# The current script refuses newer grader versions to protect analysis provenance.
pnpm exec tsx scripts/regrade-switching.ts results/muse13-switching-v3
```

The original manifest cannot execute against newer source/fixture versions. Its source
snapshot and the 3.0.1 snapshot preserve both implementations; do not overwrite the working
checkout to restore an old version. Freeze a fresh manifest for any later pilot.

## Matched pilot and metric correction

The [four-run matched pilot](v31-matched-results.md) used frozen protocol/grader 3.1.0 and
fixture `history-gateway-1.1`. Grader 3.1.1 corrects two measurement issues found during
manual review: full `get_ticket` responses put fields at the root, whereas status responses
nest them under `ticket`; and piped test output can show a failure while omitting the final
TAP summary. Mixed history/recovery test commands during urgent work are distinguished from
focused recovery failures after the first source change. None establishes a repair cycle
without checking the following source changes and test assertions.

`analysis-v311.json` preserves the original summary hash and current analysis-source hashes.
The correction runs without inference, without rerunning acceptance probes, and refuses any
change to the original workflow gates/outcome. `comparison.original-v310.*` and
`original-records.json` preserve the original comparison and record hashes. The comparison
and viewer display the versioned correction. The old 3.0.1 correction script refuses newer
grader versions, preventing accidental analysis mislabeling.

See [manual analysis guidance](manual-switching-analysis.md) and each run's `manual-review.json`.
Implementation review is complete; an independent second human reviewer remains pending.
