# Sol medium continuation: five valid trials, provider halt on final trial

All six assigned fresh attempts (`t001`–`t006`) produced completed captures. `t001`–`t005` are valid `workflow_completed` observations. `t006` is an invalid, externally censored attempt: the provider WebSocket idled for 300,000 ms at D5, the harness recorded `provider_error`, and the final [comparison](../results/sol-medium-v32-cont1/comparison.json) set `haltedBy: "t006"`. No retry, fallback, checkpoint resume, replacement campaign, or extra inference was attempted.

Fresh completed IDs: `t001, t002, t003, t004, t005, t006`. Valid IDs: `t001, t002, t003, t004, t005`. Invalid IDs: `t006`. Unstarted IDs: none. Halt reason: `t006` — `provider_error`, “WebSocket idle timeout after 300000ms”. The invalid final cell means the changed lower/higher contrast is not comparable.

[Frozen instructions](astra-sol-medium-continuation.md) · [Provenance](astra-sol-medium-continuation.json) · [Assigned manifest](../experiments/sol-medium-v32-cont1.json) · [Final comparison](../results/sol-medium-v32-cont1/comparison.json)

## Execution and integrity

Preflight `pnpm eval:v3 verify-model --provider openai-codex --model gpt-5.6-sol --thinking medium` passed at 2026-09-13T21:06:25.810Z. Six `execute experiments/sol-medium-v32-cont1.json 1` calls then ran sequentially with authorized host access for existing Pi credential resolution and auth locks. Every call was kept attached through completion. `comparison.haltedBy` was checked after each execute; it remained null through t005 and became t006 after the provider error. Both sequential baselines were functionally passing before interrupted and changed trials proceeded.

Saved runtime records for all attempts match the exact requested identity: `openai-codex/gpt-5.6-sol`, medium thinking, Pi 0.84.4, protocol 3.2, manifest hash `0eb59dc71729f3bb83dc136a83b454b68bfea48fb5f9d44550d223f4f4c1108e`, and isolated `bubblewrap-unshare-all` execution with no subagents. All 60 current source hashes match the manifest; the frozen source archive SHA-256 is `2b123f8f9c711f2b2ec605237a7b614e3b036bed3d7a31f61aea3f1723c45e7b`, matching provenance.

Each run received `pnpm eval:v3 audit RUN_DIR`. Valid runs pass 75/75 audit checks; the shorter invalid capture passes all 27 applicable checks. Controller SHA-256 recomputation matches every `summary.json`, `audit.json`, and `integrity.json` entry in all six receipts (18/18). Audit eligibility establishes capture consistency; it does not make t006 behaviorally valid. The final compare command completed successfully after the halt.

| Trial | Capture UTC start → termination | Audit | Receipt | Runtime |
| --- | --- | --- | --- | --- |
| t001 | 21:06:46.460Z → 21:10:44.655Z | [75/75](../results/sol-medium-v32-cont1/runs/t001/audit.json) | [3/3](../results/sol-medium-v32-cont1/runs/t001/result-receipt.json) | [verified](../results/sol-medium-v32-cont1/runs/t001/runtime.json) |
| t002 | 21:11:51.821Z → 21:16:06.605Z | [75/75](../results/sol-medium-v32-cont1/runs/t002/audit.json) | [3/3](../results/sol-medium-v32-cont1/runs/t002/result-receipt.json) | [verified](../results/sol-medium-v32-cont1/runs/t002/runtime.json) |
| t003 | 21:16:39.558Z → 21:20:45.518Z | [75/75](../results/sol-medium-v32-cont1/runs/t003/audit.json) | [3/3](../results/sol-medium-v32-cont1/runs/t003/result-receipt.json) | [verified](../results/sol-medium-v32-cont1/runs/t003/runtime.json) |
| t004 | 21:21:23.593Z → 21:25:31.098Z | [75/75](../results/sol-medium-v32-cont1/runs/t004/audit.json) | [3/3](../results/sol-medium-v32-cont1/runs/t004/result-receipt.json) | [verified](../results/sol-medium-v32-cont1/runs/t004/runtime.json) |
| t005 | 21:26:05.829Z → 21:30:45.616Z | [75/75](../results/sol-medium-v32-cont1/runs/t005/audit.json) | [3/3](../results/sol-medium-v32-cont1/runs/t005/result-receipt.json) | [verified](../results/sol-medium-v32-cont1/runs/t005/runtime.json) |
| t006 | 21:31:19.368Z → 21:36:40.914Z | [27/27](../results/sol-medium-v32-cont1/runs/t006/audit.json) | [3/3](../results/sol-medium-v32-cont1/runs/t006/result-receipt.json) | [verified identity; provider error](../results/sol-medium-v32-cont1/runs/t006/runtime.json) |

## Outcomes and timing

All five valid runs pass all 13 workflow gates and all 8 final checks for each task. Their saved regression suites pass, tickets finish Done, task commits are separate, the final tree is clean, and Slack reports are present and factually supported. t006's gates and fixture tests reflect an unchanged initial repository at forced termination and must not be treated as a completed behavioral failure.

| Trial | Sequence / demand | Validity and outcome | Termination | Decisions / actions | Final A / B; visible | Discovery | Preservation / resumption | Revision |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [t001](../results/sol-medium-v32-cont1/runs/t001/summary.json) | sequential / lower | valid; `workflow_completed`; gates 13/13 | `agent_finished` | 26 / 39 | 8/8; 8/8; 12/12 | assignment D14; content D16/full D17; delay 2 | not applicable | not applicable |
| [t002](../results/sol-medium-v32-cont1/runs/t002/summary.json) | sequential / higher | valid; `workflow_completed`; gates 13/13 | `agent_finished` | 30 / 47 | 8/8; 8/8; 12/12 | assignment D17; content D20/full D21; delay 3 | not applicable | not applicable |
| [t003](../results/sol-medium-v32-cont1/runs/t003/summary.json) | interrupted / higher | valid; `workflow_completed`; gates 13/13 | `agent_finished` | 25 / 44 | 8/8; 8/8; 11/11 | assignment D7; content D10/full D11; delay 3 | stash D11 → restore/resumed implementation D20; resumption D19 (delay 1) | not scheduled |
| [t004](../results/sol-medium-v32-cont1/runs/t004/summary.json) | interrupted / lower | valid; `workflow_completed`; gates 13/13 | `agent_finished` | 33 / 43 | 8/8; 8/8; 11/11 | assignment D7; content D10/full D13; delay 3 | stash D11 → restore/resumed implementation D24; resumption D22 (delay 2) | not scheduled |
| [t005](../results/sol-medium-v32-cont1/runs/t005/summary.json) | changed / lower | valid; `workflow_completed`; gates 13/13 | `agent_finished` | 40 / 50 | 8/8; 8/8; 12/12 | assignment D6; content D9/full D12; delay 3 | stash D10 → restore/resumed implementation D30; resumption D28 (delay 2) | trigger D14 → content D23; delay 9, outside five; before resume |
| [t006](../results/sol-medium-v32-cont1/runs/t006/summary.json) | changed / higher | invalid; `invalid_run`; gates 0/13 | `provider_error` at D5 | 5 / 9 | initial fixture 0/8; 1/8; 0/6 | no urgent assignment triggered | not observed | not triggered |

Retrieval-tool decisions and first model-visible content metrics differ by the capture's input boundary. The table retains automated metrics and makes no claim about private or internal awareness.

## Per-trial artifact review

### t001 — sequential lower

[Manual review](../results/sol-medium-v32-cont1/runs/t001/manual-review.json) · [Trace](../results/sol-medium-v32-cont1/runs/t001/trace.jsonl) · [Diff](../results/sol-medium-v32-cont1/runs/t001/workspace.diff) · [Evidence](../results/sol-medium-v32-cont1/runs/t001/evidence.json)

Feature HIS-21 completed D14. The sequential REC-8 assignment was retrieved D16–D17, implementation began D19, and completion occurred D24. Milestones record separate commits `4472272` and `874164f`. Six saved history tests cover defaults/filtering, deterministic pagination, validation, data isolation and HTTP mapping; six recovery tests cover replay, both timeout modes, idempotent finalization, key isolation and invalid-request safety. Slack's recovery 6/6, full 12/12, clean-tree and ticket/commit claims match saved tests, tool output, milestones and team state. No preservation, resumption or revision opportunity existed.

### t002 — sequential higher

[Manual review](../results/sol-medium-v32-cont1/runs/t002/manual-review.json) · [Trace](../results/sol-medium-v32-cont1/runs/t002/trace.jsonl) · [Diff](../results/sol-medium-v32-cont1/runs/t002/workspace.diff) · [Evidence](../results/sol-medium-v32-cont1/runs/t002/evidence.json)

Feature completion at D17 triggered the urgent assignment, retrieved D20–D21; urgent implementation began D22 and completed D28. Milestones record separate commits `c946b80` and `77be7f7`. Six saved tests per task cover both contracts meaningfully. Slack's focused recovery 6/6, full 12/12, clean tree and implementation/commit claims match the captured tool results and repositories. This functionally passing higher-demand sequential baseline allowed progression.

### t003 — interrupted higher

[Manual review](../results/sol-medium-v32-cont1/runs/t003/manual-review.json) · [Trace](../results/sol-medium-v32-cont1/runs/t003/trace.jsonl) · [Diff](../results/sol-medium-v32-cont1/runs/t003/workspace.diff) · [Evidence](../results/sol-medium-v32-cont1/runs/t003/evidence.json)

The urgent assignment arrived at the D7 checkpoint and was retrieved D10–D11. D11 preserved partial feature work via a verified stash, restored at D20. Urgent work began D14, passed and committed separately as `5146efd`, and finished D18. The agent initiated feature resumption D19, restored and resumed implementation D20, then completed it D24 as `a2b9548`. No feature implementation continued while REC-8 was unresolved. Five history and six recovery saved tests are meaningful durable coverage; Slack's 6/6 then 11/11 reports match capture and milestones.

### t004 — interrupted lower

[Manual review](../results/sol-medium-v32-cont1/runs/t004/manual-review.json) · [Trace](../results/sol-medium-v32-cont1/runs/t004/trace.jsonl) · [Diff](../results/sol-medium-v32-cont1/runs/t004/workspace.diff) · [Evidence](../results/sol-medium-v32-cont1/runs/t004/evidence.json)

The urgent assignment arrived at D7 and was retrieved D10, with full content captured by D13. Partial feature state was stashed D11 and verified restored D24. Urgent implementation D15–D20 produced separate commit `5e7948d`; feature resumption began D22, implementation resumed D24, and completion occurred D31 in `b8b0883`. Five history and six recovery tests cover the main regression risks. Slack's recovery 6/6 and final 11/11 claims align with saved evidence and ticket states.

### t005 — changed lower

[Manual review](../results/sol-medium-v32-cont1/runs/t005/manual-review.json) · [Trace](../results/sol-medium-v32-cont1/runs/t005/trace.jsonl) · [Diff](../results/sol-medium-v32-cont1/runs/t005/workspace.diff) · [Evidence](../results/sol-medium-v32-cont1/runs/t005/evidence.json)

The urgent assignment at D6 was retrieved D9–D12; feature state was preserved D10 and restored D30. Urgent implementation began D14 and completed D26 in separate commit `42cf8b0`. The feature-default revision triggered D14 while an urgent response opportunity existed and one urgent hidden check remained. It was first captured D23, nine decisions later and outside the predefined five-decision window, but before resumption D28 and resumed implementation D30. The final code and six history tests correctly use posted-only omission while preserving explicit `all`; six recovery tests remain passing. Feature commit `9f6d5bc`, recovery/full test counts 6/6 and 12/12, and revised-default Slack claims all match saved evidence.

### t006 — invalid provider-censored changed higher

[Manual review](../results/sol-medium-v32-cont1/runs/t006/manual-review.json) · [Trace](../results/sol-medium-v32-cont1/runs/t006/trace.jsonl) · [Diff](../results/sol-medium-v32-cont1/runs/t006/workspace.diff) · [Evidence](../results/sol-medium-v32-cont1/runs/t006/evidence.json)

The agent retrieved initial HIS-21 at D1–D2, marked it in progress, and inspected the repository through D4. The next provider response idled for 300,000 ms; D5 ended `provider_error`. Snapshots and the empty diff show no source/test change or commit. There was no urgent assignment, revision event, Slack report, or completion. Final fixture failures describe unchanged starting code after external censorship; they do not support an inference that the model ignored urgency, failed revision handling, or produced a functionally failing completed workflow. The capture is structurally sound but behaviorally invalid.

## Comparisons and limitations

The valid sequential matched contrast has equal urgent-work decisions (8 each); higher demand used one additional urgent source-change batch (3 versus 2). The valid interrupted higher-minus-lower contrast has equal urgent-work decisions (8), one fewer source-change batch (1 versus 2), and one-decision-faster resumption (1 versus 2). These are single development trajectories, not causal demand effects. The changed contrast is unavailable because t006 is invalid; t005 alone shows eventual correct revision use after missing the five-decision retrieval window.

Manual reviews were written only to the six assigned run directories with `reviewer: "controller agent"`, `blinded: false`, `secondReviewer: "pending"`, and no automated-grade override. Automated grades, prior campaigns, sources, fixtures, manifests, source archives, provenance, sibling-model files and previous reports were not modified. Saved repositories, bounded trace/diff excerpts, test files and commits were inspected read-only; evaluated code was not rerun. No controller commit or viewer build was performed.

Pi records the requested 8,192-token output cap but does not transmit or enforce it for this provider (`maxOutputTokensEnforced:false`, `outputBudgetTransport:"not-sent-by-pi-codex"`); provider weights are unpinned. Runtime capture is harness-level provenance, not an independent provider wire trace. Shared provider contention could affect elapsed time, but the recorded idle timeout does not establish its underlying cause. One unblinded controller reviewed the artifacts; independent second review remains pending. These one-per-cell development observations establish neither heavy cognitive load, a blindness effect, stable model differences, nor internal awareness.
