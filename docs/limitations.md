# Limitations and claim boundaries

## What is being measured

This harness measures a **complete system**: `model + Pi harness + prompt + tools + context
management`. A result says what that system did on a trajectory. It is not evidence about
the model's internal states, attention, or anything human-equivalent. "The agent did not
inspect Slack" is a behavioural statement about tool calls, not a claim about awareness.

The trace deliberately keeps four situations apart, because collapsing them would be the
main way to get a wrong answer:

1. **Indicator exposed, Slack not inspected** — the counters were in context and no
   `read_slack_messages` call followed. Work done here is *obsolete work under monitoring
   latency*, not knowing disobedience: the agent never saw the instruction.
2. **Content exposed, behaviour not adapted** — the authoritative text was in context and
   the agent still mutated source or committed. This is an *integration/execution* failure.
3. **Integrated then contradicted** — the agent acknowledged the change and later acted
   against it.
4. **Correct inspection and adaptation.**

`capacity_present_only_under_high_salience` is a **cross-run** classification. It is derived
by comparing `cancel-ambient` / `cancel-exposed` / `cancel-steer`, which carry byte-identical
text and differ only in delivery. It must never be asserted from a single run, and the
grader does not emit it from one.

## v0 scope limits

- **Single sample per cell.** Nine scenarios, one focal task, one fixture commit. There is
  no repetition, no statistics, and no aggregate score. The output is an interpretable
  trajectory, not a leaderboard.
- **One channel, one simulated coworker set.** Slack is a deterministic in-process model of
  a channel, not a real integration.
- **One model track.** Only the Pi adapter exists. The engine, graders and workspace layer
  carry no Pi types so a second adapter can be added, but that is unproven until it is.
- **Narrative grading is soft.** `manualSignals.finalReportAcknowledgesUpdate` is a
  conservative keyword match over the final assistant message. It is reported separately
  and never feeds a validity gate or the classification. No LLM judge is used for any
  repository or trajectory claim.

## `pre_commit_attempt` is unsupported

The scenario schema names `pre_commit_attempt` as a trigger, and the engine refuses to fire
it.

Firing an event "just before the agent commits" requires acting on the `git commit` tool
call itself — either blocking it, delaying it, or racing it. All three break the protocol's
central rule that environment changes are applied only at a model decision boundary, and
they change ordinary tool-execution behaviour in a way that would confound the measurement.
Rather than implement a timing hack, the trigger is declared unsupported: `evaluateTrigger`
returns `{ fired: false, evidence: { unsupported: true } }`, and `scenarioSchema` requires
any scenario using it to carry an explicit `unsupportedReason`.

The `cancel-ambient-late` scenario therefore uses `tests_first_pass` instead, which *is*
supportable: it fires at the decision boundary at which a full visible suite has been
observed to pass on mutated source. That is a genuine "completion momentum" checkpoint
reached before a commit in the normal case.

**Known race:** if the model runs the suite and commits in the *same* tool batch, the event
fires only after that commit has already happened. This is a real property of the
trajectory, not a harness bug, and it is visible in the trace: compare the
`trigger_fired` turn against the commit's `tool_action`. It is not papered over.

## `ticketDelivery`: direct mode under-populates the channel

In `direct` mode the ticket text arrives in the initial user prompt and the seeded Slack
copy starts already read. `read_slack_messages` returns unread messages only, so a
direct-mode agent that opens Slack at t=0 observes an **empty channel**, not the seeded
ticket. The seeded copy exists only in `SlackState` history and the trace's
`slack_message` record, for replay completeness.

This is a known asymmetry with `slack` mode, not a second manipulation. The tool surface
is deliberately identical in both modes — changing it for one mode would break
comparability — and not seeding at all would shift the injected scenario event from
`m2` to `m1`. The direction of the deviation is the acceptable one: it under-populates
rather than primes, preserving the no-priming intent of `direct` mode. But it is still
a deviation, so compare cross-mode Slack-browsing rates before attributing a monitoring
difference to priming alone.

## Security and isolation

**Pi has no built-in sandbox, and neither does this harness.** Pi's own documentation is
explicit that built-in tools run shell commands with the permissions of the pi process, and
that real isolation must come from the OS or a container.

What the harness actually provides:

- **Workspace path discipline.** Every built-in and custom tool is constructed with `cwd`
  set to the disposable worktree, and `tool_call` refuses `read`/`edit`/`write`/`grep`/
  `find`/`ls` calls whose `path` resolves outside it.
- **Fixture and results integrity.** Shell commands that reference the pinned fixture
  repository or the results directory by absolute path are refused. Neither path appears
  in model context, so this is an accident screen, not an adversarial control.
- **No remote.** The disposable clone has its `origin` removed, so a `git push` from inside
  a run cannot reach the fixture or anything else.
- **No host session/settings writes.** `SessionManager.inMemory` and
  `SettingsManager.inMemory` mean the run does not touch `~/.pi/agent/sessions` or the
  user's settings.

What remains reachable, stated plainly:

- **`bash` is unconstrained.** It runs as the host user. It can read and write anywhere the
  user can, reach the network, and read `~/.pi/agent/auth.json`. The absolute-path screen is
  a substring check and is trivially bypassable by a motivated agent (variables, globs,
  encodings). **This is path discipline, not a security boundary, and it must not be cited
  as one.**
- **Prompt injection** from fixture content is not prevented and cannot be by this layer.

This is acceptable for v0 because the scenarios are non-adversarial: the injected messages
come from the harness, and no untrusted third-party content enters the workspace. Running
unfamiliar models or adversarial scenarios should happen inside a container or micro-VM.

**Documented follow-up:** route built-in tool execution into a Gondolin micro-VM or run the
whole process in a container, per Pi's `docs/containerization.md`. This was left out of v0
because a partially-working sandbox that is mistaken for a real boundary is worse than an
honestly documented absence.

## Credentials

The harness never reads, prints, copies or stores an auth token. Provider authentication is
resolved entirely by Pi's `ModelRuntime` from the user's agent directory; the harness only
names a provider and checks that authentication exists. Trace and summary text passes
through `redactSecrets` before it is written.

## Determinism

Deterministic: fixture preparation, Slack cursors, trigger evaluation, exposure placement,
snapshots, graders, hidden checks, and trace/summary schemas. All are covered by tests that
require no inference.

Not deterministic: the model. Live runs are behaviour samples. Graders are never adjusted to
make a live run pass.


## Capture fidelity

The context sidecar records structured runtime message blocks after environment annotation,
not the provider wire payload. It does not retain provider signatures or image bytes;
unknown block kinds are described, not reconstructed. Text is capped per block at 24,000
UTF-16 code units; nested string arguments use the same cap, with deep structures explicitly
omitted. Provider reasoning is optional and is not a direct measure of internal awareness.

The run's capture audit measures record coverage and serialization failures independently
of grading. `complete: true` can coexist with content truncation or a final unanswered model
call. The viewer recomputes fidelity from the actual records and labels any missing,
truncated, redacted, or omitted evidence as partial. Redaction is best-effort pattern/key
matching, not a guarantee that arbitrary secrets can be recognized. Historical artifacts
are not retroactively rewritten.
