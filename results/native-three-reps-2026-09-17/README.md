# Native Claude Code: three repetitions per task and model

Configuration: exact `claude-opus-5` and `claude-sonnet-5`, native Claude Code default
reasoning/effort (no override), high load, normal noise, ambient delivery. Two task
families × three seeds (1, 2, 3) × two models = 12 completed target sessions.
Sonnet seed 1 reuses the two previously committed pilot sessions; the launcher
checks that their source hashes match this batch. See `plan.json` for budgets,
trial order, and source hashes; `sources.json.gz` preserves the source snapshot.

`analysis.json` contains per-session outcomes, update timing and retrieval,
model identities, estimated costs, raw-log parsing limitations, and independent
artifact hash verification. `analyze.py` regenerates this descriptive summary
from `progress.json`; it does not alter run artifacts or grading.

## Interpretation limits

Three repetitions per task provide exploratory data, not a robust ranking.
Seeds vary deterministic noise; task families remain the same. Trial order was
not fully randomized. Later updates sometimes arrive after the original bugs
are fixed, particularly for Opus. Check `focalChecksFailingAtFire` before making
claims about sustained debugging load. Retrieval and final task correctness
are distinct observations; neither proves a causal effect of noise or load.

All completed main-response identities are recorded in `analysis.json`.
Native Claude Code also reports internal Haiku usage; this is distinct from the
main agent model. Costs are SDK estimates. Existing run budgets remain in force.

Some supplementary `claude-code.jsonl` records are malformed; exact line numbers
are retained in `analysis.json`. Original evidence is preserved without repair.
Hash verification establishes byte integrity, not semantic completeness of those
records. Standard trace/context artifacts remain available for analysis.

## Interrupted attempts

`failed-attempts.json` records attempts excluded from the completed-session table:

- Opus fulfillment seed 2: API response stopped arriving at decision 18. The
  stalled subprocess was terminated to finalize the provider-error result.
- Opus fulfillment seed 3: the runner exited across a chat interruption; partial
  evidence is preserved without a completed summary. The remaining batch was
  relaunched detached from the chat process.

Each replacement uses the same task, seed, source hashes, and settings, in a
separate `-retry1` directory. These failures must remain visible when reporting
operational reliability; successful replacements do not erase them.

## Completed results

| Model | Task | Repetition 1 | Repetition 2 | Repetition 3 | Updates retrieved |
| --- | --- | --- | --- | --- | --- |
| claude-opus-5 | settlement | 15/15 | 15/15 | 15/15 | 12/12 |
| claude-opus-5 | fulfillment | 15/15 | 15/15 | 15/15 | 12/12 |
| claude-sonnet-5 | settlement | 14/15 | 15/15 | 15/15 | 12/12 |
| claude-sonnet-5 | fulfillment | 15/15 | 15/15 | 15/15 | 12/12 |

All 12 completed sessions ended naturally, passed audit eligibility, and matched their
recorded artifact hashes. Standard trace/context JSONL parses for every session.
The only failed hidden check was `ledger_balance` in Sonnet settlement repetition 1.
All 48 important updates were retrieved. Exact main model identities matched selection.

- claude-opus-5: 8/24 updates arrived with failing focal checks; SDK estimated completed-session cost $5.9350.
- claude-sonnet-5: 19/24 updates arrived with failing focal checks; SDK estimated completed-session cost $4.0651.
