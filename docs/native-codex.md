# Native Codex and the five-repetition matrix

`openai-codex` now launches the installed `codex app-server`. It uses the same isolated
repository, simulated Slack/Linear, neutral task prompt, event scheduler, and grader as
Claude Code. Pi provides cached pricing metadata only; it does not run Codex models.

The selected model is exact, with no fallback. `--thinking default` (also the default
when omitted) leaves Codex's reasoning setting unset. The recorded native catalog resolves
Astra to medium and Sol to low for the completed September 18 campaign. Defaults can
change in the native catalog; each new run records its resolved effort and catalog hash.
The September 19 smoke catalog resolves Astra to low and Sol to medium. Code mode is retained. Native output length is not overridden;
Claude Code retains its existing 8,192-token response cap. These are comparisons of native
agents in a controlled workspace, not identical agent scaffolds or token caps.

When BB supplies its existing Codex account-pool route and machine token, the adapter uses
that configured authentication and records `authSource: bb-account-pool`. Otherwise it
uses the local Codex login. Neither route changes the selected model or reasoning effort.

The adapter registers controlled workspace tools and disables native host environments,
external apps, skills, memory, web search, and subagents. Credentials are copied into an
isolated temporary Codex home, outside the repository visible to the model. Headers and
credentials are never recorded in artifacts.

## Decision boundaries and evidence

Codex code mode can invoke multiple workspace tools in one model response. The observer
waits until that batch has completed, snapshots the repository, applies due events, and
adds the current unread indicator before the next model request reaches the provider.
An internal native custom-provider entry directs requests through a loopback observer
to the fixed `https://chatgpt.com/backend-api` endpoint or the already configured BB Codex
pool route. This is necessary because the
built-in authenticated transport ignores the attempted base-URL overrides.

`context.jsonl` captures injected observations and normalized outputs. `codex.jsonl`
also captures actual request bodies, response events, native app-server events, and the
selected native model catalog entry. The catalog hash, native version, resolved effort,
and transport are recorded in `runtime.json`. The added indicator exists in the request
sent to the model, not in Codex's internal stored conversation.

Background code-mode cells are currently rejected as a harness limitation, rather than
attributing their later edits to the wrong decision. Such attempts cannot count as
behavioral evidence. A workspace action without an observed model request also fails closed.
Costs are estimates from the dated local pricing catalog, including context-size tiers;
they are not subscription invoices. Provider failures remain separate from behavioral failures.

## Interrupt delivery

`--delivery interrupt` is available for native Codex. The existing tasks, update text,
milestone predicates and neutral task prompt are retained. The scheduler checks those
predicates after each completed controlled tool, while holding the serialized workspace
tool queue. A newly published notification cancels the old native turn using
`turn/interrupt` and aborts queued tools from that turn. After confirmation, the adapter
waits for the old queue to settle, records its model response and usage, and starts a new
turn in the same thread with the text `New workplace notification.` The next provider
request gets the ordinary unread counts. Full update text still requires a tool lookup.

Native code mode can start a tool before its model response has finished streaming.
The adapter cancels the queued tools immediately, but waits for the final response and
usage record before requesting native interruption. This preserves accounting and
ensures the resumed request advances to a new decision with fresh unread counts.

Every new notification, including irrelevant noise, uses the same interruption mechanism.
Noise is drawn once per model decision, at its first successful controlled tool checkpoint;
bundled distractors retain their existing seeded content. An important event and its
bundled noise cause one interruption together. No hidden checks choose delivery timing.

This mode interrupts the remainder of a native code-mode batch **between controlled
tools**. It does not preempt a shell command midway through execution. A single command
can still finish all target work before delivery; existing timing eligibility checks
continue to classify that case as unassessable. Completed changes are not rolled back.
Background/yielded code-mode cells remain unsupported and fail closed.

The trace records interruption request/resume pairs and the event IDs behind each pair.
Audits check event coverage, resumed response opportunities and absence of successful
old-turn tools after cancellation. Forced cancellation earns no behavioral credit: a
resumed model can still fail by continuing canceled work, or abandoning work after noise.
Historical ambient/exposed results retain their original artifacts and grading.

`--updates disabled` is the noise-only negative control: no actionable events are sent.
Its separate outcome requires completing the original focal task and marking it done
after a noise response opportunity. It has no cancellation/downgrade adaptation score.

`interrupt-pilot` freezes six trials per family/model/repetition: cancellation and
downgrade, each with actionable-only, mixed, and noise-only conditions. The two noise-only
slots both test the original task without an incident assignment; they are matched control
repetitions, not two different suppression scenarios. One family and one repetition per
model produces the proposed 12-session pilot. No main sessions are launched by freezing.

```sh
pnpm eval freeze experiments/sol-interrupt-pilot-v1.json sol-interrupt-pilot-v1 interrupt-pilot \
  --families settlement --reps 1 --seed 1 --provider openai-codex --model gpt-5.6-sol
pnpm eval run --family settlement --scenario task-cancellation --load high \
  --delivery interrupt --noise normal --provider openai-codex --model gpt-6-astra
```

The native smoke test uses scripted Responses over loopback, not paid model inference:

```sh
CODEX_INTEGRATION_TEST=1 pnpm exec vitest run tests/codex-interrupt.integration.test.ts
```

It covers both model configurations, repeated interruptions, queued parallel tools,
same-thread continuation, actual provider-input notification capture, noise-only success
and failure, deliberate stop-instruction violations, the single-command timing limit,
and tools that execute before the final streamed response record arrives.

## Commands

```sh
pnpm eval verify-model --provider openai-codex --model gpt-6-astra
pnpm eval run --family settlement --scenario task-cancellation --load high \
  --provider openai-codex --model gpt-5.6-sol

pnpm eval freeze experiments/astra-five.json astra-five scenario-matrix \
  --reps 5 --seed 1 --provider openai-codex --model gpt-6-astra
pnpm eval execute experiments/astra-five.json --concurrency 2
```

`scenario-matrix` schedules eight cases: two families × original updates, cancellation,
urgency downgrade, and delayed relevance. All use high load, normal noise, and ambient
delivery; cancellation is a suppression test, not a load comparison. Five repetitions
produce 40 sessions per model. Original-update seeds are 1–5, matching the saved baseline;
the three new arms retain their existing family/replicate seed scheme.

Use repeatable `--reuse <saved-directory>` options during freezing to fill matching slots
with existing evidence. Model, native agent, scenario, seed, fixture, prompt, protocol,
timing version, and audit must match. The known 1.0→1.1 exception applies only to retained
cancellation/delayed runs because that revision changed downgrade timing alone.
Saved summaries and integrity files are hash-pinned and re-audited. A behavioral failure
is reusable. Reuse never rewrites or regrades the saved files. Provider or harness failures
are not reusable. The viewer includes cached runs under their new experiment's cached slots.

Two independent sessions per model can run concurrently. The batch pauses on provider or
harness errors and preserves completed work; `execute` resumes pending work under the same
source snapshot. Behavioral failures remain results and do not trigger retries.

## Validation

```sh
pnpm typecheck && pnpm test
CODEX_INTEGRATION_TEST=1 CLAUDE_CODE_INTEGRATION_TEST=1 \
  pnpm exec vitest run tests/codex.integration.test.ts tests/claude-code.integration.test.ts
```

Native integration tests use synthetic credentials and a local fake Responses API. They
exercise native code mode, sequential/parallel inner tool calls, default reasoning, the
three new arms, exact request indicators, usage accounting, and budget termination.

Protocol reference: [Codex app-server](https://developers.openai.com/codex/app-server/).
