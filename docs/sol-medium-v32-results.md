# Sol medium v3.2 experiment — halted campaigns

Both Sol campaigns halted at their first scheduled trial. The original campaign failed before
inference because the controller sandbox could not access the model-catalog credential path. A
separately frozen, parent-authorized retry campaign reached the assigned model, then the provider
reported that its usage limit had been reached at decision 21. Neither campaign supplies a valid
model result, and no matched comparison is possible.

## Campaign status

| Campaign | Completed IDs | Halt | Valid model results | Remaining trials |
| --- | --- | --- | ---: | --- |
| `sol-medium-v32` | none | `t001`: setup/controller failure before inference | 0 | `t002`–`t006` not started |
| `sol-medium-v32-retry1` | `t001` capture completed, result invalid | `t001`: provider usage limit at D21 | 0 | `t002`–`t006` not started |

The original failed attempt remains under `results/sol-medium-v32/`. Its only execution artifact
is `runs/t001/attempt-error.json`, which records no fallback; a controller review was added later.
There is no runtime, trace, summary,
audit, receipt, termination, repository, commit, test, Linear-behavior, or Slack artifact because
no evaluated session started. This is an infrastructure failure, not model behavior.

The retry used frozen sources, fixtures, task schedule, budgets, prompt hash, provider, model and
reasoning settings identical to the original; only the campaign identity and creation timestamp
differ. Runtime records `openai-codex/gpt-5.6-sol`, requested thinking `medium`, protocol `3.2`, Pi
0.84.4, isolated execution, no subagents, and no fallback. The requested 8,192-token output cap was
recorded but not transported by the Pi Codex adapter (`maxOutputTokensEnforced:false`), as expected
by the frozen pilot design.

## Trial-by-trial factual observations

| Campaign/trial | Validity and outcome | Termination / functional gates | Decisions and discovery | Preservation / resumption | Revision timing |
| --- | --- | --- | --- | --- | --- |
| original `t001` sequential/lower | setup/controller failure; no model result | catalog verification failed before inference | none | not observed | not applicable |
| original `t002` sequential/higher | not started | halted by `t001` | none | not observed | not applicable |
| original `t003` interrupted/higher | not started | halted by `t001` | none | not observed | not observed |
| original `t004` interrupted/lower | not started | halted by `t001` | none | not observed | not observed |
| original `t005` changed/lower | not started | halted by `t001` | none | not observed | not observed |
| original `t006` changed/higher | not started | halted by `t001` | none | not observed | not observed |
| retry `t001` sequential/lower | completed capture; `invalid_run`; excluded from comparison | provider error at D21; assignment, priority, paused-status, feature correctness, urgent preservation and visible-test gates pass; urgent done/commit, both done, clean tree and Slack gates fail | 21 decisions / 35 tool actions; urgent assignment published D15, cue/list D16, content D17, full content/status D18, first urgent edit D20; discovery delay 2 | feature A was already committed/done; no preservation transition or resumption was needed | no revision scheduled |
| retry `t002` sequential/higher | not started | halted by `t001` | none | not observed | not applicable |
| retry `t003` interrupted/higher | not started | halted by `t001` | none | not observed | not observed |
| retry `t004` interrupted/lower | not started | halted by `t001` | none | not observed | not observed |
| retry `t005` changed/lower | not started | halted by `t001` | none | not observed | not observed |
| retry `t006` changed/higher | not started | halted by `t001` | none | not observed | not observed |

## Partial retry artifact review

Facts:

- The independent audit is eligible and all 63 checks pass, including identity, chronology,
  provenance, replay, immutable observations, snapshots, and artifact hashes. The receipt hashes
  for `summary.json`, `audit.json`, and `integrity.json` were independently recomputed and match.
- Feature A was implemented at D7–D10, its focused tests passed at D13, and commit `f8d46d7` was
  created at D14 before the ticket was marked done at D15. The saved commit contains history source
  plus durable regression tests covering default/all status, deterministic ordering, filtered
  cursor pagination, malformed input, merchant/cursor scope, aliasing, and handler error mapping.
- Urgent task B was retrieved after A completed. The agent inspected B at D19 and edited
  `src/recovery/service.mjs` at D20. The archived urgent checkpoint passes all eight B functional
  checks, and the captured final probes pass all eight A and all eight B checks.
- B had no added regression test, no commit, no Done transition, and no Slack report. The retained
  workspace has one modified B source file. Team state ends with HIS-21 done and REC-8 in progress.
- No Slack messages exist, so there are no test-count or commit claims to validate. No paused-work
  revision occurred in the only started retry trial.

Interpretation:

- Passing capture audit and functional probes do not make the run valid; provider termination
  prevented completion of the required workflow. The comparison correctly counts one invalid run
  and zero eligible observations.
- The partial trajectory suggests prompt task discovery and technically effective edits, but it
  cannot support a completed-workflow judgment, a matched lower/higher contrast, or any model-level
  conclusion. The five unstarted conditions provide no evidence about interruption, preservation,
  resumption, or paused-feature revision timing.

## Artifacts, preservation, and limitations

- Original frozen manifest: `experiments/sol-medium-v32.json`; original halted comparison:
  `results/sol-medium-v32/comparison.json` and `comparison.md`.
- Retry frozen manifest: `experiments/sol-medium-v32-retry1.json`; retry halted comparison:
  `results/sol-medium-v32-retry1/comparison.json` and `comparison.md`.
- Retry `t001`: `summary.json`, `runtime.json`, `audit.json`, `result-receipt.json`, `trace.jsonl`,
  `workspace.diff`, archived repositories, and `manual-review.json` under
  `results/sol-medium-v32-retry1/runs/t001/`.
- Exclusive controller reviews are stored in each attempted run directory with
  `reviewer:"controller agent"`, `blinded:false`, and `secondReviewer:"pending"`. Automated grades
  were not overwritten.
- All attempt artifacts and the retained invalid workspace were preserved. No attempt was deleted,
  overwritten, bypassed, or silently retried. No evaluation source, fixture, lockfile, package file,
  manifest, source archive, sibling-model artifact, or viewer artifact was changed, and no commit
  was made in the evaluation repository.
- Further inference depends on restored provider capacity. Keep these halted campaign IDs intact;
  later observations must use fresh attempt IDs and preserve these failures. Do not resume inside
  or overwrite an existing attempt. No revision-timing inference is available.

These are bounded development artifacts. They do not establish stable model performance, heavy
cognitive load, or a demand effect. Independent second review remains pending.
