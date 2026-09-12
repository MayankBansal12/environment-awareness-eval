# Status and next experiment — September 12, 2026

The environment is ready for bounded behavioral pilots. The task family has not yet
established heavy cognitive load. A small Astra–Sol comparison is useful for discovering
different strategies and omissions; repeating the current easy successes at scale would
provide less information than improving task demand.

## Implemented and validated

- v2: isolated repository tools, simulated Linear and Slack, two demand variants, and five
  cancellation/delivery conditions. Independent audits and frozen experiment manifests.
- v3: history feature A, urgent refund-recovery fix B, preservation and unaided resumption,
  optional reminders, and revised feature requirements. Sequential/interrupted/reminded/changed
  sequences support silent, Linear, Linear plus Slack, and direct-content delivery.
- Separate retrieval, priority, preservation, resumption, correctness, and reporting evidence;
  private probes on archived checkpoints; versioned corrections preserve original records.
- Viewer support for both tracks and historical results. Single-agent execution only.

Validation on this checkout: 240 harness tests and 131 viewer tests passed, both TypeScript
checks passed, and the viewer built. The 33 skipped viewer checks require the archived
historical corpus. Six formatting failures in the older Claude integration were corrected.

The four matched Muse trajectories passed their audits and all final acceptance checks.
One omitted durable regression tests despite passing automated workflow gates. Higher demand
required more urgent-module changes, but did not consistently take longer and produced no
focused recovery-test failures after the first urgent edit. A is identical across demand
variants and mostly implemented at its first edit. These observations do not establish
load-induced blindness. See [the trace-backed report](v31-matched-results.md).

## Prerequisite for Astra and Sol

The v2/v3 runtime, manifests, and identity audits explicitly permit only free Muse on ZEN.
There is no working v3 `--model` flag. The old v0 Astra adapter does not make v3 selectable.
Do not compare new v3 runs with historical v0 Astra results as if they share a protocol.

Add explicit model/provider configuration throughout runtime creation, frozen manifests,
run summaries, audits, comparison grouping, and viewer identity. Preserve the free-Muse
default and refusal of unrequested fallback. Verify `gpt-6-astra` and `gpt-5.6-sol` through
the installed Pi provider before launching inference; account access was not checked here.
Add deterministic checks for identity mismatch, unsupported settings, and wrong-model
results. Freeze fresh manifests; old manifests remain historical records.

## Recommended first comparison

Use the same Pi version, tools, system prompt, fixture, progress triggers, grading, and
budgets for both models. Start with the same supported reasoning setting, such as `high`,
and record the effective settings and token use; equal labels do not imply equal compute.
Keep runtime retries explicit and retain every failed attempt.

| Condition | Demand | Runs per model | Purpose |
| --- | --- | ---: | --- |
| Sequential A then B | Lower and higher | 2 | Normal completion and demand calibration |
| Interrupt A with B, no revision | Lower and higher | 2 | Preservation, priority and unaided return |
| Interrupt A with B, revise paused A | Lower and higher | 2 | Refresh and adaptation on resumption |

This is **12 runs total**, one observation per model/condition/demand cell, initially using
the Linear unread indicator. Execute sequential baselines first, then interleave models in
matched blocks with a recorded schedule. Review baselines before spending the remaining
budget. This schedule needs new model-aware manifest support; no such campaign was launched
or frozen by this status review. Keep bounded execution and the existing stop-on-invalid
attempt behavior.

For each trace, record cue → urgent card → full requirements → pause/preserve → urgent Done
→ actual return → refreshed feature → final verification. Compare pre-retrieval edits,
post-retrieval priority errors, stash/notes use, revision timing relative to resumed edits,
saved regression coverage, and factual handoff claims. Inspect diffs alongside decisions.
An update to paused A may correctly wait until resumption. Token counts and elapsed time
are descriptive; they do not establish cognitive load.

Use an independent second reviewer for ambiguous priority and coverage judgments; this is
still pending for the Muse pilot. Task-specific measures, retained traces, and human
calibration of automated scores follow [OpenAI evaluation guidance](https://developers.openai.com/api/docs/guides/evaluation-best-practices).
The exact matrix above is a project recommendation, not a prescribed sample size.

## What follows the pilot

If the models show useful differences, freeze the chosen diagnostic cells and collect
several repetitions, reporting raw counts and uncertainty. One trajectory cannot rank them.
If both finish easily, refine the tasks before scaling: leave substantial interacting feature
work at the checkpoint, then add a requirements update affecting the currently active urgent
fix. Pair it with an unchanged-task control and direct-content delivery control, and recalibrate
solvability and response opportunity. A harmless update is a later check against stopping or
switching on every notification. Subagents and nested interruptions remain separate extensions.

## Artifact and commit scope

Source, tests, reports, historical workflow scripts, manifests, and frozen source snapshots
belong in this checkpoint. Raw current runs under `results/` and generated viewer output
remain ignored local artifacts; committing the code does not back them up. The frozen source
archives preserve the precise historical implementations, including pre-formatting bytes.
Any new inference must freeze the current sources under a new experiment name.

The previous thread intentionally archived all 95 historical runs and removed them from the
active corpus. Its archive and checksum manifest remain under
`/home/mayank/.bb-machines/mayank.getbb.app/thread-storage/thr_scf7kin2t2/backups/results-20260911T095327Z/`.
The eight deleted tracked reference files are part of that authorized reset. Historical
report links into `results/` require the archived corpus; use a separate extraction directory
when reviewing it. Current v2/v3 raw traces remain in the active local results directory.
