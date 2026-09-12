# Astra and Sol at medium reasoning — v3.2 pilot

The September 12 user request authorizes v3 model support and two concurrent controller
threads, one for Astra and one for Sol, both at medium reasoning. Evaluated sessions use
controlled Pi and isolated repository tools. Controller context is not passed to them.

Tasks, delivery, triggers, fixtures, prompt and grader remain unchanged. Protocol 3.2 adds
explicit model/provider/reasoning identity, rejects fallback and mismatched results, and
separates comparison groups by model and reasoning. Historical Muse records remain intact.

Medium reasoning is supported in the local BB catalog and official model documentation:
[Astra](https://developers.openai.com/api/docs/models/gpt-6-astra) and
[Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol). Pi access is checked separately
before launch; no default reasoning setting is assumed.

## Frozen design

| Trial | Sequence | Demand | Delivery |
| --- | --- | --- | --- |
| t001 | Sequential | Lower | Linear indicator |
| t002 | Sequential | Higher | Linear indicator |
| t003 | Interrupted | Higher | Linear indicator |
| t004 | Interrupted | Lower | Linear indicator |
| t005 | Revise paused feature during urgent work | Lower | Linear indicator |
| t006 | Revise paused feature during urgent work | Higher | Linear indicator |

One observation per cell per model: 12 planned runs. Schedule seed 20260912 controls demand
order, not model sampling. Each model executes sequentially, baselines first. Controllers run
concurrently, so elapsed times can reflect shared host and provider contention. Every evaluated
run has its own repository, session, home/tmp, Linear and Slack state.

Per-run budgets: 80 decisions, 200 tool actions, 900000 ms of active session time; medium
reasoning and an 8192-token requested output cap. Provider enforcement depends on the installed
Pi adapter: Pi 0.84.4's Codex adapter does not send that output cap to the backend, and the
runtime records `maxOutputTokensEnforced:false`. Both models use this same transport limitation.
Captured runtime context is not a provider wire trace. No runtime retries,
compaction, subagents, or model fallback. Capture actual identity and limits in runtime.json;
catalog costs are not observed billing.

Retain and stop on invalid/incomplete attempts or provider failures. A functionally failing
sequential baseline stops that model's schedule. Valid interruption behavior failures are
results and are not rerun to obtain success.

## Execution

```sh
pnpm eval:v3 verify-model --provider openai-codex --model gpt-6-astra --thinking medium
pnpm eval:v3 verify-model --provider openai-codex --model gpt-5.6-sol --thinking medium
pnpm eval:v3 freeze experiments/astra-medium-v32.json astra-medium-v32 model-comparison 20260912 --provider openai-codex --model gpt-6-astra --thinking medium
pnpm eval:v3 freeze experiments/sol-medium-v32.json sol-medium-v32 model-comparison 20260912 --provider openai-codex --model gpt-5.6-sol --thinking medium
# Each worker repeats only its own invocation after checking the previous result.
pnpm eval:v3 execute experiments/astra-medium-v32.json 1
pnpm eval:v3 execute experiments/sol-medium-v32.json 1
```

Creation is exclusive; use fresh names for subsequent experiments. Source files must stay
unchanged after freezing. The saved workflow .bb/workflows/astra-sol-medium-v32.js assigns
disjoint run/report paths and explicit medium reasoning to both controller threads.

## Analysis

Compare cue/content retrieval, source work before and after retrieval, priority, preservation,
unaided return, refresh before resumed implementation, both tasks' correctness, saved regression
tests, and factual handoffs. Keep validity, functionality, workflow and manual coverage/report
judgments separate. Cite decisions and artifacts; inspect ambiguous shell changes before
calling them priority violations.

These samples show trajectories, not stable model rankings. Demand changes urgent task B only;
initial feature A and its interruption are identical. Paused-feature revisions can correctly
wait until resumption. Existing calibration does not establish heavy cognitive load. Further
fixture refinement and replication depend on observed results.

## Launch record

Validation before launch: 251 harness tests, both typechecks, viewer rendering checks,
formatting and viewer build passed. A historical matched-Muse run still passes all 75 audit
checks. Both live provider/authentication preflights verified the exact requested model and
medium reasoning without inference. The initial two manifests have identical source hashes,
trials, prompt hash and budgets.

Workflow: `wfr_72af94ce-2f45-447f-b7c1-0c346df9b373`. Astra controller:
`thr_ibx34mezn6`; Sol controller: `thr_hyzk5u7dwc`.

The first Sol controller invocation used the restricted outer execution sandbox before
receiving the parent's credential-access note. It retained a t001 setup failure under
`results/sol-medium-v32/`, with no model inference. The original halted manifest and attempt
remain intact. The parent authorized one fresh campaign under
`experiments/sol-medium-v32-retry1.json`, with source, schedule, budget, prompt and model
configuration verified identical. The same Sol controller continues using elevated outer
execution access for the existing credential resolver; evaluated repository tools remain
inside their original bubblewrap boundary. This is an infrastructure retry, not a repeated
behavioral outcome. The Sol report must include both campaign IDs.

The workflow has finished auditing both schedules. Provider usage limits stopped Astra at
t002 and Sol's retry at t001; see [the combined results](astra-sol-medium-results.md).
