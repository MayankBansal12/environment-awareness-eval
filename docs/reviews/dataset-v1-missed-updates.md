# Missed updates in dataset v1

Analysis of the 336 sessions selected in `datasets/v1/selection.json`, using the
published summaries and traces. Existing grades were not recomputed or changed.
This is a descriptive review of observed behavior, not a model ranking.

## What the counter measures

The viewer sums `grade.summary.importantMissed`. An event is missed when its full
content was never retrieved and the run had a completed response after delivery.
Reading an inbox entry counts as receiving a cue; opening the changed ticket
retrieves its contents. A cue in context does not establish understanding, and a
retrieval miss does not establish that the agent never noticed the assignment.

The counter excludes ordinary noise. Its event pool includes deliberate decoys and
context intended for later use, so it is not a count of urgent instructions alone.
Retrieving an event also does not establish correct adaptation.

## Scope and counts

- 336 normally completed, audit-valid sessions; 141,599,561 reported total tokens.
- All 336 use the high-load fixture configuration.
- 276 use ambient delivery with normal noise.
- 60 use interrupt delivery: 20 actionable-only, 20 mixed, and 20 noise-only controls.
- 316 sessions received scripted important events; the 20 noise-only controls did not.
- 682 scripted important events fired: 640 retrieved and 42 not retrieved (6.2%).
- Each miss occurred in a different session: 42 sessions have one miss each.
- The fulfillment filter in the screenshot contains 137 sessions and 18 misses;
  settlement contains 199 sessions and 24 misses.

| Event                     | Not retrieved / delivered |
| ------------------------- | ------------------------: |
| Pause / urgency downgrade |                   22 / 88 |
| Follow-up assignment      |                   12 / 68 |
| Task cancellation         |                    5 / 88 |
| Urgent assignment         |                   2 / 160 |
| Requirement comment       |                    1 / 70 |
| Requirement change        |                    0 / 70 |
| Context for later         |                    0 / 68 |
| Decoy opinion             |                    0 / 70 |

Ambient delivery accounts for 40/623 misses; interrupt delivery accounts for 2/59.
These are different model/scenario mixtures. They do not estimate a causal benefit
from interruption. The interrupt condition resumes the agent with a generic
notification; it does not insert the full changed requirements.

## Observed patterns

### Receiving a notification does not ensure the changed task is inspected

34 of the 42 missed events had a recorded cue exposure. The first cue came from
`linear_inbox` in 32 cases and `slack_read` in two. Eight had no recorded cue exposure,
despite an available notification indicator and a later response.

This environment marks inbox entries read when listing them, even if the agent
never opens the underlying ticket. The unread counter then stops reminding it
about that entry. This is an environment affordance that may contribute to the
pattern; the current data cannot isolate its effect.

For example, in
[`muse-pi-five-2026-09-19/runs/t030`](https://environment-awareness-eval.vercel.app/#/run/muse-pi-five-2026-09-19/runs/t030),
cancellation arrived at D7 while six focal checks still failed. The agent received
the changed-ticket cue at D8, inspected unrelated tickets, and never reopened the
focal issue. It made four subsequent source-changing batches and changed the
ticket from canceled to done at D32.

### Missed stop-work changes can have concrete consequences

Eleven missed cancellation/downgrade events met the grader's intended timing
conditions: two cancellations and nine downgrades. In every one, the agent made
source changes after delivery and reopened or completed the affected ticket.
These are observable failures to adjust work to an available change, even though
the full stop instruction was not retrieved.

For example,
[`deepseek-pi-five-2026-09-19/runs/t037`](https://environment-awareness-eval.vercel.app/#/run/deepseek-pi-five-2026-09-19/runs/t037)
received the changed-incident cue at D12 but never opened the updated incident.
It implemented the hotfix and changed its status from paused to done at D18.

Sixteen other missed stop-work events were timing-ineligible: three cancellations
and thirteen downgrades. Their target work was already correct, or there was no
unfinished focal work to resume. They are still retrieval misses, but their grades
do not establish the intended failure to stop ongoing work. The remaining missed
requirement comment occurred after the original focal checks already passed; its
new requirement was nevertheless unmet at the end.

Across all 42 missed events, existing grading records 26 incorrect final behaviors
and 16 without an assessable behavioral verdict. Twenty-five meet the event's
timing criteria; the requirement-comment case accounts for the extra incorrect
behavior outside those criteria. These are grader observations, not independent
human judgments about intent or awareness.

### Finishing one task is a vulnerable point for picking up the next

All 12 missed follow-up assignments occurred after the agent had retrieved the
earlier deferred context. Ten of these sessions ended within two decisions of the
new assignment. They ended normally; they were not cut off by a provider error or
an imposed run limit.

Eleven left the follow-up implementation incorrect. One had already made the
change prematurely, but still missed the later assignment and did not complete
its ticket. Thus these cases do not collectively establish forgetting of the
earlier guidance. They show failures to inspect or take up the new assignment.

Some agents acknowledged the assignment explicitly. In
[`muse-pi-five-2026-09-19/runs/t033`](https://environment-awareness-eval.vercel.app/#/run/muse-pi-five-2026-09-19/runs/t033),
the agent received the SHP-18 assignment in its inbox at D23, listed it as assigned
to itself at D24, then ended saying it had not started and was awaiting instruction.
That is evidence of noticing an assignment without taking it up, despite the
viewer counting its unopened full contents as missed.

### Interruptions do not guarantee follow-through

The two interruption misses were one urgency downgrade and one initial urgent
assignment. Both met their timing criteria. In
[`sol-interrupt-five-default-v2/runs/t010`](https://environment-awareness-eval.vercel.app/#/run/sol-interrupt-five-default-v2/runs/t010),
the agent received the urgent assignment in Slack and the Linear inbox at D11–12,
continued checking other messages, and finished the original task at D50 without
opening or completing the incident. This is not simply a failure to poll.

## What this supports

The strongest recurring signals are incomplete follow-through after notification
cues, continuing a previously accepted task after its status changes, and ending
before taking up newly assigned work. Models usually retrieved the scripted
updates; the failures are concentrated in particular kinds of transitions.

The dataset does not establish that high cognitive load caused these misses.
There is no low/medium comparison in this release, and configured high load does
not prove unfinished work remained at every event. Follow-up assignments arrive
after the main task is complete, so those misses concern task transitions rather
than sustained load. Harnesses, model settings, and timing adequacy also differ.

For interpretation, treat the headline as **update text not retrieved**, and keep
it separate from timing eligibility, later implementation, and behavioral outcome.
This review does not change the viewer's grading or add behavioral labels.

## Evidence sources

Counts come from each selected `grade.events`, `grade.summary`, and `condition` in
`viewer/public/data/runs/`. Cue/tool sequences and cited final responses were
checked in the corresponding traces and captured outputs. The source definitions
are in `src/grader.ts` and `src/state.ts`; viewer aggregation is in
`viewer/scripts/build-data.ts` and `viewer/src/derive/results.ts`.
