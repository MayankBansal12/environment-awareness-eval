# Astra and Sol medium: Pi continuation results

The Pi rerun produced ten valid completed trajectories and one provider timeout. Together
with the retained Astra baseline, 11 of the 12 planned cells now have valid observations:
six Astra and five Sol. Ten have automated `workflow_completed`; Astra's interrupted/higher
cell retains `manual_review_required`, with artifact review supporting compliant stash
preservation. Every valid observation passes all 16 final acceptance checks.

Sol's changed/higher attempt ended at D5 with `provider_error`: “WebSocket idle timeout
after 300000ms”. It had made no code changes and had not received an urgent assignment or
revision. This is an invalid observation, not a completed behavioral failure. The trace does
not establish the underlying cause of the idle connection. No replacement attempt was run.

Workflow `wfr_0c1ef886-e632-43df-afb8-7f557ee99a04` is finished with no running workers.
The original provider-limited attempts and setup failure remain separately preserved.
Across both launches there are 14 inference attempts and one pre-inference setup failure;
the table below selects 12 cells, including the final invalid Sol attempt. One planned
observation per cell is too little to rank the models or estimate stable success rates.

## Matched observations

Numbers are harness decisions / tool actions. A decision can contain multiple actions and
an action can contain several shell operations; these counts are not tokens, cost, or a
standardized measure of effort. All completed cells below pass 8/8 feature and 8/8 recovery
checks. The original Astra lower baseline predates the continuation.

| Case | Astra / medium | Sol / medium |
| --- | --- | --- |
| Sequential, lower | Completed; 28 / 27, retained baseline | Completed; 26 / 39 |
| Sequential, higher | Completed; 28 / 27 | Completed; 30 / 47 |
| Interrupted, higher | Valid; automated review flag; 23 / 22 | Completed; 25 / 44 |
| Interrupted, lower | Completed; 25 / 24 | Completed; 33 / 43 |
| Changed, lower | Completed; 27 / 26 | Completed; 40 / 50 |
| Changed, higher | Completed; 30 / 29 | Invalid provider timeout; 5 / 9 before termination |

Both models retrieved urgent work, paused and preserved unfinished feature changes, finished
the urgent fix in a separate commit, and returned to the feature in all completed
interrupted and changed cases. Controller reviews found durable regression tests and
supported final Slack claims. Astra used fewer tool actions in the five matched completed
cells; command batching and these single observations limit any efficiency interpretation.

Astra retrieved urgent assignments after two decisions in each valid run. Sol took two in
its lower sequential baseline and three in the other valid runs. Both resumed paused work
within one or two decisions after urgent completion, according to the recorded resumption
metric. That metric marks return to the feature; implementation may begin later.

## Changed requirements

| Model / demand | Revision retrieval delay | Urgent checks still failing at revision checkpoint | Retrieved before resumed implementation | Final revised feature |
| --- | ---: | ---: | --- | --- |
| Astra / lower | 5 decisions | 0 | Yes | Correct |
| Astra / higher | 6 decisions | 4 | Yes | Correct |
| Sol / lower | 9 decisions | 1 | Yes | Correct |

Astra lower met the predefined five-decision retrieval window. Astra higher and Sol lower
missed it, then used the revised requirements correctly in the completed feature. Astra
retrieved the revision after urgent completion; Sol lower retrieved it while urgent work
was still underway. The final Sol cell cannot supply a higher-demand contrast.

The workload manipulation is not consistently stronger in these trajectories. Astra's
interrupted higher variant took six urgent-work decisions versus seven for lower; Sol's
interrupted variants both took eight. Several revision/checkpoint moments had no hidden
urgent checks left to fix. Delayed retrieval here does not establish an awareness failure
or an effect caused by cognitive load.

## Astra's priority flag

The parent inspected the flagged trace independently of the controller's conclusion, while
unblinded to model and grade. At D11, Astra successfully stashed the feature service and
read recovery files. The feature digest returned to the initial fixture and stayed there
through urgent completion at D15. The recovery-writing command at D14 touched only recovery
source and tests. At D19, `git stash pop` succeeded, then the same shell action implemented
the feature query/handler and tests. The saved feature service is byte-identical to its
pre-interruption checkpoint.

The grader requires the entire feature digest to equal its pre-stash value at a settled
snapshot containing stash restoration. D19's additional implementation changed that digest
before the snapshot, so the grader could not verify restoration. The evidence supports
preservation and correct priority ordering. The automated outcome and receipts remain
unchanged; this focused parent review does not constitute a blinded second review of all
behavioral claims.

Evidence: [trace](../results/astra-medium-v32-cont1/runs/t003/trace.jsonl), decisions 11,
14, 15 and 19; [checkpoint service](../results/astra-medium-v32-cont1/runs/t003/checkpoint-repo/src/history/service.mjs);
[completed service](../results/astra-medium-v32-cont1/runs/t003/feature-done-repo/src/history/service.mjs);
[grader rule](../src/v3/grader.ts). The service SHA-256 and evidence hashes are saved in the
[machine-readable report](astra-sol-medium-cont1-results.json).

## Verification and artifacts

The parent reran persisted-capture audits for all 12 selected observations: 852/852 checks
passed, including 777 for the 11 fresh attempts. All 36 selected result-receipt entries
match; receipts for the two earlier provider-limited inference attempts also match. Exact
model identity, requested medium reasoning, protocol 3.2, manifest/trial linkage and all
60 source-file hashes were verified. The invalid timeout capture is intact but remains
invalid for behavioral comparison. No evaluated code was rerun or modified during review.

- [Astra controller report](astra-medium-v32-cont1-results.md).
- [Sol controller report](sol-medium-v32-cont1-results.md).
- [Machine-readable results and parent verification](astra-sol-medium-cont1-results.json).
- [Continuation plan](astra-sol-medium-continuation.md) and [frozen provenance](astra-sol-medium-continuation.json).
- [Original halted-campaign report](astra-sol-medium-results.md).

Controller reviews are unblinded; a blinded second behavioral review remains pending.
Provider weights are unpinned, and Pi does not transmit the requested output-token cap.
Captures establish harness provenance rather than an independent provider wire trace.
Reports, manifests and source archives are tracked; raw captures remain local ignored files.

## Next steps

1. Collect one fresh Sol changed/higher attempt with the same frozen settings and a new
   campaign ID, preserving the timeout. This requires a new explicit launch; none is
   scheduled automatically.
2. Address the stash-and-edit batching case in a versioned grader change with a focused
   regression test. Keep original grades intact and label any later derived reanalysis.
3. Before scaling, review the retrieval windows and calibrate whether higher demand leaves
   sustained urgent work at the revision opportunity. Then preregister repeated matched
   trials with a blinded artifact review. These pilot results justify that follow-up, not
   a claim that one model is more aware.
