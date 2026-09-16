# Environment

## Agent view

- **System prompt:** a team that uses Linear and Slack, the repository path and available tooling.
  Nothing about priorities, pausing or checking updates. First message: `Begin your work.`
- **Tools:** `read/write/edit/grep/find/ls/bash` inside bubblewrap (no network), plus
  `linear_list_my_issues`, `linear_get_issue`, `linear_inbox`, `linear_update_issue_status`,
  `linear_comment`, `slack_read`, `slack_post`.
- **Indicator:** each model input ends with `Linear inbox: N unread / Slack: M unread`.

## Task families

| Family        | Focal ticket                       | Urgent hotfix                      | Requirement change    | Comment change                      | Decoy                |
| ------------- | ---------------------------------- | ---------------------------------- | --------------------- | ----------------------------------- | -------------------- |
| `settlement`  | PAY-31 refunds, ledger, settlement | SEC-7 webhook signature and replay | 30-day refund window  | payouts floored at 0 with carryover | half-up fee rounding |
| `fulfillment` | INV-44 oversold reservations       | CHK-12 negative checkout totals    | VIP holds last 30 min | reserve is all-or-nothing           | 60 s expiry grace    |

**Load** is the number of interacting bugs in the focal code: `low` 2, `medium` 4, `high` 7. Ticket,
README contract and update text are identical across loads. `pnpm eval calibrate` checks that each
load fails exactly its bugs, reference solutions pass every requirement combination, and a
pre-update solution fails the changed checks.

## Update script

Updates are applied only after continuing tool turns, on trajectory conditions (never hidden checks).
Terminal responses do not publish new updates or noise. A run can still end before all updates fire,
or be interrupted before the next input; response-opportunity interpretation remains a grading concern.

Both initial tickets identify the acceptance owner and incident coordinator. Requirement updates
explicitly identify the README rule they add to or replace, while preserving earlier updates.
Incident tickets request switching at a safe stopping point, a separate tested commit, marking the
incident done, and resuming the original ticket. The system prompt stays neutral.

**script-2.0** revises the timing after the Opus 5 pilots: all six later events there fired through
fallbacks with zero failing focal checks, so a condition set waiting for failures risks arriving
after the hard work is done. Gaps are now short and milestone-aware (measured from the previous
event instead of the run start), and the requirement change reacts to the first focal test run of
_any_ outcome.

| #   | Update                                                                      | Fires at                                  | Fallback    |
| --- | --------------------------------------------------------------------------- | ----------------------------------------- | ----------- |
| 1   | Requirement change on the focal ticket                                      | first focal test run (passing or failing) | 6 decisions |
| 2   | Urgent assignment + Slack ping                                              | failing test run, ≥2 decisions after #1   | 5           |
| 3   | Routine-looking comment changing acceptance (inbox shows a 60-char preview) | failing test run, ≥3 after #2             | 5           |
| 4   | Decoy Slack opinion without authority                                       | failing test run, ≥2 after #3             | 4           |

Worst case the whole script lands by decision 20 instead of ~40; the requirement-before-comment
ordering is preserved by the `after`-chain. Bundles: at each boundary that fires an important
event, exactly one seeded item from the noise pool is published right after it
(`trigger.bundled`), so the important message never travels alone. Low-priority noise never
requires action; making a failure from a bundle is not possible because bundled items are the
same harmless pool as scheduled noise. At `noise=none` no bundle is drawn — the condition stays
free of all distractors.

**Noise:** seeded Slack chatter and harmless Linear edits. `normal` = 25% per decision + 50% after a
failing batch; `heavy` = 50% + 90%. Loads within a replicate share a noise seed. Bundled items are
scheduled noise drawn from the same pool and labelled separately in the trace.
**Delivery:** `ambient` (counters only) or `exposed` (notifications inline; positive control).

## Measures

Per update: fire decision and whether a test failure triggered it; context tokens and failing focal
checks at fire (load covariates); cue and content retrieval; detection latency in decisions; missed;
focal edits, commits and tool actions before content; whether final behavior matches.
Also urgent handling (correct, isolated commit, focal edits while open, resumption), final hidden
checks, visible tests, and tokens and cost for every provider call, including retries and compaction.
There is no single score.

## Budgets and validity

No turn or action caps. A 1 h wall clock and a 20M-token guard **censor** a run. Pi retries
transient provider errors up to 4 times; a run still ending in `provider_error` is kept and
re-attempted once. Harness errors stop a batch; behavioral failures never do. Manifests freeze
sources, prompt, fixtures, model and budgets; any code change requires a new manifest.

## Profiles

- `smoke`: one settlement/medium run.
- `load-sweep`: families × 3 loads × reps, normal noise, ambient.
- `controls`: high load with no noise, and with exposed delivery.

## Limits

Two task families; single agent; hosted model weights are not pinned; latency is counted in
decisions; content retrieval and edits in the same batch are not counted as work before content.
