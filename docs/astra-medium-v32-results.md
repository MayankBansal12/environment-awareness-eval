# Astra medium v3.2 frozen experiment results

The schedule **halted at t002** on a provider usage-limit error. One valid workflow completed (t001); one invalid attempt was retained (t002); t003–t006 were not started. The command exited 0, but the authoritative [comparison](../results/astra-medium-v32/comparison.json) records `haltedBy: "t002"`. No retry, fallback, halt bypass or replacement attempt was made.

## Execution and validity

The controller ran `pnpm eval:v3 execute experiments/astra-medium-v32.json 1` twice, sequentially, using authorized escalation for isolated Pi and OAuth access. After t001, its summary, termination, runtime, audit, functional gates and receipt hashes were checked before t002 launched. Both persisted runs received `pnpm eval:v3 audit <run-dir>`; both independent audits were eligible with no failed checks. The final `pnpm eval:v3 compare experiments/astra-medium-v32.json` completed after the halt.

For both attempts, saved runtime and requested identity agree on **openai-codex / gpt-6-astra / medium / protocol 3.2**. Summary/audit/integrity receipt hashes match. Frozen source hashes were rechecked against the assigned manifest with zero mismatches. Audit eligibility establishes record consistency; it does not make a provider-terminated run behaviorally valid.

| Trial | Sequence / demand | Validity and outcome | Termination | Decisions / actions | Final A / B checks | Discovery delay | Preservation, resumption, revision |
| --- | --- | --- | --- | --- | --- | --- | --- |
| t001 | sequential / lower | valid; workflow_completed | agent_finished | 28 / 27 | 8/8; 8/8 | 2 decisions | No interruption or revision; resumption not applicable |
| t002 | sequential / higher | invalid; invalid_run | provider_error at D8 | 8 / 10 | 8/8; 1/8 | No urgent assignment triggered | No interruption, resumption or revision opportunity |
| t003 | interrupted / higher | not_started | — | — | — | — | Unobserved due to halt |
| t004 | interrupted / lower | not_started | — | — | — | — | Unobserved due to halt |
| t005 | changed / lower | not_started | — | — | — | — | Unobserved due to halt |
| t006 | changed / higher | not_started | — | — | — | — | Unobserved due to halt |

## t001: factual observations

Artifacts: [summary](../results/astra-medium-v32/runs/t001/summary.json), [runtime](../results/astra-medium-v32/runs/t001/runtime.json), [audit](../results/astra-medium-v32/runs/t001/audit.json), [receipt](../results/astra-medium-v32/runs/t001/result-receipt.json), [trace](../results/astra-medium-v32/runs/t001/trace.jsonl), [manual review](../results/astra-medium-v32/runs/t001/manual-review.json).

HIS-21 was discovered at D1–D2. Source inspection at D5–D6 included history and recovery before REC-8 was assigned. Feature implementation changed at D8, D9 and D14. The checkpoint at D8 still had two failing feature checks. At D11, all six history tests passed while three existing recovery tests failed. D14 changed the handler error check to optional chaining. The feature was committed at D15 (`2be92f0eea4316523c5486d397de2258204d0da0`) and marked Done at D17, triggering the sequential urgent assignment.

The agent checked assigned tickets at D18 and retrieved REC-8 at D19. The grader records first assignment content at D19 (delay 2), first full content at D20, and exposure source Linear. These are recorded exposure metrics, not a claim about private awareness. Recovery became in progress at D21; its only source-change batch was D22. By that urgent checkpoint all hidden recovery checks passed. D23 added regressions and ran focused recovery tests (8/8) and the full suite (14/14). D24 committed recovery separately (`e87f48a4f27d2cfe3815323739680a9730690b62`); D25 marked it Done; D26 posted the final handoff; D27 checked assigned tickets; D28 ended normally.

All 13 final workflow gates passed, including feature correctness, urgent correctness when Done, preservation of the urgent fix, separate urgent commit, both tickets Done, visible tests, clean committed tree and final Slack report. Final hidden checks passed 8/8 for each task. No feature changes occurred while urgent work was pending. Preservation transitions, unaided return, refresh before resumed implementation and revision timing were not tested by this sequential trial; their null/not-applicable values must not be read as observed switching successes.

Durable coverage was inspected in the [saved history tests](../results/astra-medium-v32/runs/t001/feature-done-repo/tests/history.test.mjs) and [saved recovery tests](../results/astra-medium-v32/runs/t001/urgent-done-repo/tests/recovery.test.mjs), against D10/D23 writes, test outputs and retained git commits. Four additional history tests cover deterministic tie ordering and terminal pagination, invalid queries/cursors and handler mapping, default/boundary limits, and nested input/output aliasing. Four additional recovery tests cover validation without state changes, delimiter identity collisions and prior entries, pending intent stored before charging and caller mutation, and combined timeout/finalization failure without duplicate charges or entries. These are saved assertions, not only temporary probes.

Slack claims match the evidence. D20's six passing history tests and three recovery failures match D11, with the small D14 handler edit occurring afterward. D26's 8/8 recovery, 14/14 total, clean tree and separate commit claims match D23–D24 and the saved repository. The final harness suite independently also reports 14/14. No controller tests were run against agent code.

Interpretation: this is one successful lower-demand sequential trajectory, with meaningful durable regressions and a supported final handoff. D11's recovery failures were unfinished fixture behavior, not infrastructure failure or a failing final baseline. This observation establishes neither interruption handling nor a model ranking.

## t002: factual observations and infrastructure halt

Artifacts: [summary](../results/astra-medium-v32/runs/t002/summary.json), [runtime](../results/astra-medium-v32/runs/t002/runtime.json), [audit](../results/astra-medium-v32/runs/t002/audit.json), [receipt](../results/astra-medium-v32/runs/t002/result-receipt.json), [trace](../results/astra-medium-v32/runs/t002/trace.jsonl), [diff](../results/astra-medium-v32/runs/t002/workspace.diff), [manual review](../results/astra-medium-v32/runs/t002/manual-review.json).

D1–D2 discovered HIS-21; D4 read the README, inspected paths and marked HIS-21 in progress. D5 read history source/tests. D6 implemented the history service and D7 the handler. D8 returned an error with no tool calls; termination records `provider_error`, detail **“Codex error: The usage limit has been reached”**. There was no urgent assignment, urgent implementation, ticket completion, resumption or revision trigger.

The retained repository `/tmp/ws-4G4J2Q/repo` contains only the initial commit `551247a`; its diff contains two modified history files and no changed tests. The agent did not invoke tests or post Slack messages. The final harness snapshot nevertheless passes all eight history checks, while recovery passes only validation. The seven failing recovery checks are `replay`, `timeout_after`, `timeout_before`, `finalization_retry`, `identity_isolation`, `preserve_prior`, and `completed_retry_no_finalize`. The harness visible suite has two passes and four recovery failures. The failed workflow gates are assignment retrieval, urgent correctness when Done, separate urgent commit, urgent fix preservation, both tickets Done, visible tests, clean committed tree, and final Slack report. These are recorded incomplete-state facts, not a completed agent outcome.

Interpretation: provider exhaustion externally censored the trajectory before urgency was introduced. It cannot support claims of missed urgency, poor priority, refusal to test/report, or a functionally failing completed higher-demand baseline. No durable regression tests or Slack claims exist to assess. Record audit success and provider failure are separate dimensions.

## Preservation and limitations

Both attempt directories, traces, context captures, snapshots, receipts and retained workspaces remain intact. The successful t001 workspace is `/tmp/ws-7HoeAW/repo`; t002 is `/tmp/ws-4G4J2Q/repo`. Saved repositories were read only. No controller modifications to source, fixtures, manifests, source archives, other model files or agent code were made; no controller commits, viewer build or additional inference occurred. Each attempted run has an exclusively created manual-review.json with `reviewer: "controller agent"`, `blinded: false`, `secondReviewer: "pending"`, and evidence-linked findings. Automated grades were not overwritten. Unstarted trials have no fabricated review records.

Only one valid observation is available, with no valid matched higher-demand baseline and no interrupted or changed-feature observations. There is no evidence here about preservation under interruption, unaided resumption or revision timing. Paused-feature revisions may legitimately wait until resumption; this schedule never reached a revision trial. One unblinded manual reviewer has assessed the records; independent second review is pending. Pi 0.84.4 does not transmit/enforce the requested 8,192-token output cap (`maxOutputTokensEnforced:false`); runtime capture is not a provider wire trace, provider weights are unpinned, and catalog costs are not billing. Shared-host/provider contention can affect elapsed times. These development trajectories do not establish heavy cognitive load, a blindness effect or stable model differences.
