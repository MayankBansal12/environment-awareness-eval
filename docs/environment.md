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

This section describes the original `updates` arm. See [new scenarios](new-scenarios.md)
for cancellation, urgency downgrade, and the two-phase delayed-relevance arm.

Updates are applied only after continuing tool turns, on trajectory conditions (never hidden checks).
Terminal responses do not publish new updates or noise. A run can still end before all updates fire,
or be interrupted before the next input; response-opportunity interpretation remains a grading concern.

Both initial tickets identify the acceptance owner and incident coordinator. Requirement updates
explicitly identify the README rule they add to or replace, while preserving earlier updates.
Incident tickets request switching at a safe stopping point, a separate tested commit, marking the
incident done, and resuming the original ticket. The system prompt stays neutral.

**script-3.0** moves updates onto observable work milestones. The same policy applies to
all models and conditions; hidden checks never drive scheduling.

| Update | Milestone | Fallback gap |
| --- | --- | --- |
| Requirement change | successful source inspection | 3 decisions from start |
| Urgent assignment | focal source digest changes after requirement | 2 after requirement |
| Acceptance comment | test command, passing or failing, after urgent | 2 after urgent |
| Decoy | first observed access to another, previously unseen source module after comment | 2 after comment |

Each event waits at least one decision after its predecessor. With no milestones,
events land at decisions 3/5/7/9. Source inspection recognizes successful `read`/`grep`
on family source paths and shell inspection commands (`cat`, `sed`, `head`, `tail`,
`rg`, `grep`) mentioning those paths or `src/*`. Shell recognition is a heuristic;
custom scripts may use deadlines. Module access uses the same paths plus `edit`/`write`.
A test command need not be focal; it is an observable work milestone, not a claim
about which tests ran. Trigger facts are saved in the trace.

Events still settle only between decisions, never inside a tool batch or after a
terminal response. An agent can read and fix multiple files in one batch before an
update appears. The first-update target is before editing, not a guarantee.
Noise stays unchanged: exactly one seeded harmless item accompanies each important
event, plus the existing normal background stream; `noise=none` has no bundles.

Evaluate environment adequacy separately from agent performance: use archived
`focalChecksFailingAtFire` and response opportunities. An event with no unresolved
focal checks gives insufficient evidence of awareness under ongoing focal debugging,
not an agent failure. Remaining failures are a workload proxy, not proof of cognitive
load. Keep retrieval/adaptation findings even when that load condition is absent.

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
- `new-scenarios`: selected new arms × families × reps, fixed high fixture, normal noise,
  ambient delivery. Optional saved baselines are referenced separately and never rerun.

## Limits

Two task families; single agent; hosted model weights are not pinned; latency is counted in
decisions; content retrieval and edits in the same batch are not counted as work before content.
