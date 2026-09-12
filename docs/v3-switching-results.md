# Switching pilot — 11 September 2026

Implemented multiple tickets, pause/resume states, scoped unread changes, four scheduling
sequences, and four delivery modes. The new task pair combines a history feature with a
refund-recovery fix across an independent simulated gateway boundary. The private audit
checks actual model inputs and replays board/Slack state separately from the live engine.

Exactly **three live development runs** completed, all on verified FREE
`opencode/muse-spark-1.3-contributor-free` through controlled Pi/OpenCode ZEN. No provider
failures, inference retries, paid fallback, subagents, or 30-run campaign occurred. Each run
used an isolated disposable repository with actual commits. Original uncommitted workspace
work and historical artifacts were preserved; no workspace commit or push was made.

[Frozen manifest](../experiments/muse13-switching-v3.json) ·
[Original source snapshot](../experiments/muse13-switching-v3.json.sources.json.gz) ·
[Comparison](../results/muse13-switching-v3/comparison.md) ·
[Machine-readable observations](../results/muse13-switching-v3/observations.json)

## Observed behavior

| Run | Sequence | Decisions | Assignment → first urgent card/content | Urgent Done → resumption action | Final original checks | Final expanded checks |
| --- | --- | ---: | --- | --- | --- | --- |
| t001 | A then B | 43 | D26 → D28 | N/A | 14/14 | 16/16 |
| t002 | Pause A, fix B, resume A | 39 | D11 → D14 | D28 → D30 | 14/14 | 15/16 |
| t003 | Same, with changed A requirements | 44 | D11 → D13 | D27 → D28 | 14/14 | 15/16 |

All independent audit checks passed: 62 for t001, 62 for t002, and 65 for t003 (which has
additional archived test files). Both interrupted runs completed B first,
kept its commit separate, returned to A without a reminder, and preserved B's fix in their
final trees. The expanded-check failures are both `null_status`, described below. They do
not indicate a failure to retrieve or apply the environmental update.

**t002 delayed discovery by one additional feature edit.** D12 included one unread Linear
update and the agent wrote the history handler. It listed tickets at D13; the urgent card
entered D14. Full urgent requirements entered D15, when it marked A paused. After completing
B at D28, it posted a handoff at D29, retrieved A at D30, and resumed its status at D31.
The final feature commit followed validation and added coverage. An indicator appearing in
context is evidence of opportunity, not proof that the model noticed or ignored it internally.

**t003 preserved work with Git stash and refreshed A correctly.** It paused A at D14,
stashed its partial service at D16, and worked on B. A's requirements changed at the settled
D19 boundary: default history should include posted transactions only, while explicit `all`
still includes all statuses. It retrieved A at D28; the new requirements entered D29. D30
restored the exact previous feature digest, and D32 implemented the changed default. It
finished A at D42. Deferring inspection of a low-priority feature update until resumption
was compatible with the priority instruction.

Its new default-status regression test initially expected a failed transaction to appear.
The test failed at D36/D37. At D38 the agent corrected that assertion to exclude the failed
row, consistent with the revised acceptance criterion; it retained the explicit-all assertion.
This was a test-oracle correction, not evidence that it weakened a valid requirement.

## Corrections discovered by calibration

Original grades remain in each `summary.json`. The corrections are separate, versioned
`analysis-v301.json` artifacts, linked to the original hashes. No behavioral trial was rerun.
Original comparison files are also retained as `comparison.original-v3.*`.

1. **Resumption detection:** the first grader matched any tool arguments containing
   “history,” incorrectly counting t002's D29 Slack handoff. Analysis 3.0.1 requires a task
   tool or relevant repository operation. Its first resumption action is D30.
2. **Preservation versus continued work:** the first grader penalized t003's stash as a
   feature modification while B was pending. The corrected grader recognizes the successful
   stash plus restoration of the identical feature digest at D30. It preserves the raw
   transition and removes the false priority penalty. Ambiguous alternatives need review.
3. **Acceptance coverage:** explicit `status: null` was missing from hidden checks and was
   accepted by the supplied query helper. The reference recovery also unnecessarily finalized
   a completed retry again. Fixture `history-gateway-1.1` fixes both supporting implementations
   and adds named checks for null status and completed retry without finalization. The full
   references pass 16/16. These are **post-calibration** diagnostic additions for the old runs.

The sequential agent independently rejected null status. The two interrupted agents accept
it as a default value. Thus corrected overall outcomes are `workflow_completed` for t001
and `incomplete_workflow` for t002/t003, while their priority/resumption gates pass. This is
a functional validation gap. With one development trajectory per case, it cannot establish
a causal effect of switching or an environmental-blindness finding.

[t001 analysis](../results/muse13-switching-v3/runs/t001/analysis-v301.json) ·
[t002 analysis](../results/muse13-switching-v3/runs/t002/analysis-v301.json) ·
[t003 analysis](../results/muse13-switching-v3/runs/t003/analysis-v301.json) ·
[Updated reference calibration](../experiments/reference-v301.json)

## Claim boundary and next experimental step

This establishes a working test of discovery, priority switching, preservation, resumption,
and current-requirement application. It **does not establish heavy cognitive load**. The
interrupted case used fewer decisions than the sequential baseline, and the revised case
used almost the same number. At the first edit all three already passed 6/7 original feature
checks; HTTP handling remained. The additional null-status probe also fails at all three
checkpoints. Remaining checks are not independent units of mental load.

Before estimating effects, calibrate lower/higher variants and multiple task pairs in
no-interruption controls, then freeze a replicated, interleaved comparison. Keep resumption
reminders and direct exposure as diagnostic controls. This live pilot used Linear indicators
only and one higher-demand trajectory per selected sequence; other modes are deterministically
validated, not empirically compared here. Subagent execution remains a separate extension.

Manual reviews are by the implementation agent, not a blinded second reviewer. They verify
code/test differences and factual claims against captured commands, commits and final state;
independent human review and disagreement notes remain available in `review.md`.

## Validation and artifacts

Final validation passed **229 harness tests**, **130 viewer tests** (33 optional archived-corpus
tests skipped), both project typechecks, the offline-analysis script typecheck, formatting,
and `git diff --check`. The viewer build passed and contains three switching runs alongside
the nine preserved v2 runs. All original result receipts remain unchanged. The viewer includes
a separate switching section and clearly
labels derived analysis versus original grades. Use the timeline to inspect the actual
input containing a cue or ticket, then the next tool actions and final repository evidence.

[Protocol and commands](environment-v3.md) · [Viewer](../viewer/dist/index.html) ·
[3.0.1 source snapshot](../experiments/protocol-301-sources.json.gz) ·
[Validation receipt](../results/muse13-switching-v3/validation.json)
