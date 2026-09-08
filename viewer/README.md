# viewer

A local, read-only results viewer for the eval harness. It reads `results/`, validates
every trace against the harness's own Zod schema, and emits one self-contained
`viewer/dist/index.html` with the data inlined.

```bash
pnpm viz                              # build from repo-root results/, print the output path
EAW_RESULTS_DIR=<dir> pnpm viz        # build from another results tree
pnpm --filter @eaw/viewer build:data -- --results <dir>   # flag form (then pnpm viz)
pnpm viz:test                         # derivation tests only
```

Open the printed path directly — it works over `file://`, with no server. The results
directory is an input, matching the runner's own `--results <dir>` flag: `--results
<dir>` on the build script beats `EAW_RESULTS_DIR`, which beats `<repo>/results`. An
absent or unreadable directory builds an empty state, not a crash; 0, 1 and N runs all
render.

## What it is not

No server, no database, no pagination, no live socket, no state of its own. The whole
`results/` tree is small enough to inline, so it is. Nothing here writes to `results/` or
couples to the runner.

## Single source of truth

The viewer must never disagree with the grade it renders beside, so it does not restate
anything the harness already defines:

| Concern | Source |
| --- | --- |
| Trace validation | `traceEventSchema` from `src/trace/schema.ts` |
| Summary shape | `EvalSummary` type from `src/runner.ts` |
| Test pass/fail | `classifyTestOutcome` from `src/engine/triggers.ts` |
| bash = test vs commit | `TEST_PATTERN` / `COMMIT_PATTERN`, imported from `src/grading/grader.ts` |

Tool output is capped at `MAX_TOOL_OUTPUT_PREVIEW` (1500 UTF-16 code units), **not** the
4000 of `MAX_TRACE_TEXT`, and `outputBytes` is a byte count — comparing the two mixes
units. A v5 trace records `outputTruncated`/`outputChars` outright; older traces are read
via the note the writer appended. Both go through `truncationOfAction`.

`TEST_PATTERN` and `COMMIT_PATTERN` are exported from the grader precisely so the
viewer can label a `bash` action exactly the way the grader counts it. The import is
direct — no regex copies, no source-text scraping — so a combined
`pnpm test && git commit` reads as a commit attempt in the timeline whenever the grader
counts it as one.

A mixed-generation corpus is the normal case, not drift: the loader accepts trace
schema v1/v2/v3/v4/v5 and summary v1/v2/v3. Each event is normalised onto the local schema
version before validation (`viewer/src/derive/trace-compat.ts`); a missing
`ticketDelivery` becomes `slack`, a missing `authoritativeContentMessageIds` becomes
empty. A run that still cannot be parsed is **quarantined**, never fatal: it gets a
badge in the index with its reason and is excluded from every aggregate, while
everything else still renders.

## Screens

- **Run index** — one clickable row per run, with model, outcome, inspection delay and
  post-update actions. Search and filters persist when returning from a run. Invalid runs
  are labeled and excluded from every outcome aggregate.
  Unparseable runs are quarantined with a badge and their reason, likewise excluded
  from aggregates without stopping the rest from rendering.
- **Run cockpit** (the default run screen) — test cases, agent activity, terminal logs and
  the Slack workspace on one screen, all slaved to a single `decisionIndex` cursor. Moving
  the cursor once answers the question the eval exists to ask: at this model call, what was
  in the channel, what did the agent know about it, and what did it do next. The rail shows
  repeats of a condition as labeled buttons so run-to-run variance is visible without navigating; the
  scrubber marks the indicator and content decisions so the gap is a distance rather than a
  number to subtract. Slack messages are stamped with what the agent knew at the cursor —
  `unread`, `indicated` (a status-block count and nothing more), `read`, or `exposed`.
- **Run detail** — the same run at action granularity, for when the question is "prove it".
  The header states the indicator→content gap first, because that gap is the result. The
  timeline is a digest of phase bands by default (`explore`, `modify`, `inspect`, `report`,
  `test`, `commit`, `shell`), expandable to individual actions and then to raw trace JSON.
  Exposure markers are full-width bands; rows between the indicator and the content are
  tinted, because work in that window is obsolete work under monitoring latency, not
  disobedience. Clicking any row shows the exact `decision_boundary` context.
- **Compare** — two runs side by side, aligned on `decisionIndex`, which is a shared
  logical clock across runs. A decision present on one side only renders as a hatched
  blank, so trajectory divergence stays visible.

## Notes on the current corpus

Verified with `jq` against `results/` rather than assumed:

- `assistant_turn.text` is empty on every tool-using turn; only the final `stop` turn
  carries prose. The activity view is therefore derived from tool actions plus whatever
  reasoning the trace recorded, and the final report tab renders the run's final prose in
  full.
- **Reasoning is captured on the v4 runs and absent from everything older.** Across 439
  v4 turns, 19% carry reasoning text (median 173 characters — these are short summaries,
  not raw chain-of-thought), a further 47% report reasoning tokens with no text, and 34%
  carry nothing. Every pre-v4 trace predates capture entirely, so the cockpit says the
  trace predates capture rather than implying the model reasoned about nothing. The three
  cases are kept apart deliberately — `not_captured` (trace < v4), `none_returned` (the
  provider sent no thinking blocks) and `redacted` (a safety filter withheld the
  plaintext) — because only the second is a fact about the model.
- `observedTestOutcome` is **optional**: the bulk of the corpus records it on test
  commands, the oldest runs omit it. The recorded value wins when present; otherwise the
  timeline falls back to the grader's own `classifyTestOutcome`, so its ✓/✗ still
  matches the grade either way.
- `inputSummary.path` is **absolute** across most of the corpus
  (`/tmp/eaw-run-<id>-XXXX/workspace/…`) and repo-relative in the two oldest live runs.
  The workspace prefix is stripped before rendering, so both shapes read as repo paths.
- Every `tool_action` carries a `batchId` of the form `turn-<n>`, and a batch of one is
  the common case and is not bracketed. **`batchId` is not unique within a run before trace
  v5**: it was named after the runtime's turn index, which restarts at 0 when a provider
  error restarts the session, so an older trace can carry `turn-0` several times. Batches
  are therefore keyed on `decisionIndex|batchId` (`batchKey` in `batches.ts`) — a batch is
  the calls from one assistant message and cannot span decisions, so this is correct for
  every generation and repairs the older ones on read.
- `summary.json` `schemaVersion` is mixed 1/2/3 across the corpus, as is the trace
  `schemaVersion` (v3 adds a required `ticketDelivery` to `run_start`; v4 adds optional
  reasoning fields to `assistant_turn`; v5 adds `outputTruncated`/`outputChars` to
  `tool_action` and moves turn identity onto the engine's own monotonic counter). Mixed versions are accepted and normalised, not
  warned about — except a trace that mixes versions *within itself*, which indicates a
  concatenated or corrupted artifact.
- `summary.json` on the oldest runs carries no round or ticket-delivery field. Rounds
  are read from an `r<n>` segment in the run id and fall back to ordinal position; a
  missing `ticketDelivery` is treated as `slack`.
