# Astra–Sol medium pilot: provider usage limit stopped the comparison

Only one of the 12 planned trajectories completed: Astra's lower-demand sequential baseline.
Astra's next baseline and Sol's first baseline both ended with `provider_error` and the message
`Codex error: The usage limit has been reached`. Neither model reached the interruption or
changed-requirements conditions. These data cannot compare switching or resumption behavior.

| Model | Case | Recorded decisions | Result | Acceptance checks at termination |
| --- | --- | ---: | --- | --- |
| Astra / medium | Sequential, lower | 28 | Valid, workflow completed | 16/16 |
| Astra / medium | Sequential, higher | 8 | Invalid: provider usage limit | 9/16; work incomplete |
| Sol / medium | Sequential, lower | 21 | Invalid: provider usage limit | 16/16; workflow incomplete |

Decision counts include the final captured error decision where present. They are not
comparable completion times. Nine scheduled cells remain unstarted: four Astra and five Sol.
There was also one Sol setup failure before inference; it is retained separately from these
three inference attempts. A fresh, explicitly recorded Sol campaign corrected outer sandbox
credential access without changing source, prompt, model settings, schedule or budgets.

## What the artifacts establish

Astra finished the feature, then retrieved and completed the subsequently assigned urgent fix.
Both tickets ended Done, source and regression tests were committed, all 16 acceptance checks
passed, and all automated workflow gates passed. This was sequential work: interruption,
paused-work preservation, and unaided resumption were not exercised.

Sol completed and committed the feature before retrieving the urgent assignment. Its last
source edit repaired the urgent service, and the saved repository passes all 16 probes. The
provider stopped it before it could finish urgent-task tests, commit, status and reporting.
Those missing deliverables are unfinished work at external termination, not evidence that Sol
would have omitted them in a completed run. No success rate or model ranking is justified.

Astra's higher-demand attempt stopped before the urgent assignment was published. It supplies
no observation of higher-demand recovery work or interruption response.

The parent independently recomputed all original result-receipt hashes for the three inference
attempts and checked their exact runtime identity: openai-codex, the assigned Astra/Sol model,
medium reasoning, and protocol 3.2. Each saved capture audit is eligible. Capture integrity
and completed experimental validity are separate: the two provider failures remain invalid
behavioral results even though their partial evidence is intact.

## Artifacts

- [Design, controls, and launch history](astra-sol-medium-pilot.md).
- [Astra controller review](astra-medium-v32-results.md) and
  [Astra comparison](../results/astra-medium-v32/comparison.md).
- [Sol controller review](sol-medium-v32-results.md),
  [retained setup failure](../results/sol-medium-v32/comparison.md), and
  [Sol retry comparison](../results/sol-medium-v32-retry1/comparison.md).
- [Machine-readable campaign evidence](astra-sol-medium-results.json), including original
  artifact hashes and per-run settings, outcomes, and denominators.

The controller reviews cite concrete decisions and files. The parent checked identity,
receipts and outcome classifications; an independent blinded second review of the behavioral
interpretations remains pending. Raw runs and retained repositories remain local ignored
artifacts, while source, manifests, source snapshots and reports are tracked.

## Next step

Restore provider capacity before further inference; the returned error does not establish a
reset time. Keep these halted campaigns intact. Use fresh attempt IDs with the same frozen
source and medium settings for later observations, recording all provider failures. Finish
baseline calibration and then collect interruption/revision cases before comparing models.

No additional retries, fallback models, or automatic quota polling are scheduled. The current
evidence does not justify making tasks harder or attributing any difference to cognitive load.
