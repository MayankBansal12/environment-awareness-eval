# Architecture

This document covers the historical protocol. See [environment v2](environment-v2.md) for
the new isolated tool boundary, Linear state, paired fixtures, and separate schemas. The
repository also contains the later `src/claude/` native CLI bridge; statements below about
a single Pi seam reflect the initial architecture.

## Module boundaries

```text
src/
  cli.ts                      argument parsing, scenario listing, dry-run entry
  runner.ts                   run orchestration: prepare → run → snapshot → grade → write
  config/
    run-config.ts             validated run configuration (provider/model/limits/paths)
    scenario-schema.ts        Zod schema for the experimental factors
  scenarios/
    messages.ts               the canonical, authoritative Slack payloads
    catalog.ts                the nine curated v0 scenarios
  prompt/system-prompt.ts     the controlled system prompt and initial user prompt
  engine/
    slack.ts                  monotonic message ids, unread cursor, read/post semantics
    environment.ts            status/event block rendering and context anchoring (pure)
    triggers.ts               semantic trigger predicates + one-shot wrapper
    experiment.ts             the decision-boundary state machine
  tools/
    slack-tools.ts            read_slack_messages / post_slack_message
    path-guard.ts             workspace path discipline + fixture integrity screen
  workspace/
    git.ts                    pinned Git environment and exec helpers
    manager.ts                fixture verification, disposable clone, disposal
    snapshot.ts               Git/workspace snapshots and mutation detection
  pi/adapter.ts               the ONLY module that imports the Pi SDK
  trace/
    schema.ts                 normalized trace event schema (Zod)
    writer.ts                 append-only JSONL writer + secret redaction
  grading/
    artifact-evidence.ts      persisted evidence schema consumed by the graders
    grader.ts                 validity gates, outcome gates, metrics, classification
    hidden-checks.ts          external post-run behaviour checks
```

`engine/`, `grading/`, `workspace/` and `tools/` contain no Pi types. `pi/adapter.ts` is the
seam: it translates Pi's event stream into engine calls. A Claude Code or OpenCode track
would add a sibling adapter and reuse everything else.

## The decision-boundary protocol

Pi may issue several tool calls in one assistant message and execute them concurrently.
Exposing an environment change when an arbitrary sibling happens to finish would make the
result depend on a completion race. The harness therefore only ever changes what the model
can perceive at a **model decision boundary**.

Per boundary, in order:

1. The model emits one assistant turn / tool batch.
2. Every already-issued tool in that batch settles.
3. `settleTurn` records the actions and takes one workspace/Git snapshot.
4. `settleTurn` evaluates the semantic trigger and, if it fires, applies the environment
   event **exactly once**.
5. `decisionBoundary` renders exactly one current status block (and, under `exposed`
   delivery, the full event block) into the context of the next model call.
6. That model invocation is recorded as the first opportunity to perceive the change.

Mapped onto Pi 0.84.4:

| Protocol step | Pi hook | Why |
| --- | --- | --- |
| 2–4 | `turn_end` | Fires after the assistant message *and* every tool result has been appended. Extension handlers are awaited, so work here completes before the loop continues. |
| 5–6 | `context` | Fires once immediately before each LLM request, with a `structuredClone` of the messages, and the returned array is what is sent. |
| tool observations | `tool_execution_end` + `turn_end` | Results are collected as they settle and attributed to actions in assistant source order at the boundary. |
| reasoning capture | `turn_end` | `AssistantMessage.content` is `(TextContent \| ThinkingContent \| ToolCall)[]`; `assistantInfo` reads all three. Thinking is recoverable only here — nothing downstream can reconstruct it. |
| path guard | `tool_call` | The only place a tool call can be refused before execution. |
| `steer` delivery | `session.steer()` from `turn_end` | Pi's agent loop polls `getSteeringMessages()` immediately after `turn_end`, so the steered message lands before the next model call — the same boundary the other delivery modes use. |

Verified against `dist/core/extensions/runner.js` (`emitContext` deep-clones and returns the
transformed array), `dist/core/sdk.js` (`transformContext` wiring), and
`pi-agent-core/dist/agent-loop.js` (turn/steering order, awaited listeners).

## Where the environment surface lives in context

`context` receives a per-call copy, so annotations never enter persisted session history.
The harness rebuilds the surface deterministically on every call:

- **Current status** — one `<environment_status>` block appended to the *tail* observation
  (the last `toolResult`, or the initial user message before any tool has run). Because it
  is rendered fresh each call from live Slack state, sibling results from one batch can
  never disagree, and no stale status accumulates.
- **Exposed event** — the `<environment_event>` block is *anchored* to the message that was
  the tail when it was delivered (keyed by `toolCallId`), and re-applied to that same
  message on every later call. The event stays where it first appeared and the prompt
  prefix stays stable.

`annotateMessages` is a pure function over a structural message type, so the whole exposure
layer is unit-tested with plain object literals and no SDK.

## Reasoning

`assistant_turn` carries optional `reasoningText`, `reasoningRedacted` and
`reasoningTokens`, populated from Pi's `ThinkingContent` blocks and `usage.reasoning`.
Whether anything arrives is the provider's decision: some return raw thinking, some return
a summary, some return nothing, and a safety-filtered block carries an encrypted signature
with no plaintext. The fields are therefore **omitted** rather than emitted empty when a
provider returns nothing, so three states stay distinguishable downstream — the harness
never looked (trace < v4), the provider returned none, or the text was redacted. The token
count is recorded separately because providers that withhold the text often still report
it, which is enough to show that reasoning happened.

## Logical time

`decisionIndex` (model decision opportunities) and `logicalActionIndex` (tool actions) are
the experiment's only clocks. Triggers, exposure ordering and latency metrics use them
exclusively. `wallClockIso` is recorded per trace event for diagnostics and is never read
by a trigger or a grader.

## What is Pi default vs. overridden

Overridden for every controlled run:

| Surface | Setting | Effect |
| --- | --- | --- |
| System prompt | `DefaultResourceLoader({ systemPrompt })` | Replaces Pi's default prompt entirely. |
| Extensions | `noExtensions: true` + one inline factory | Only the harness's own observer loads. |
| Skills | `noSkills: true` | No automatic skills. |
| Prompt templates | `noPromptTemplates: true` | No slash commands. |
| Context files | `noContextFiles: true` | No `AGENTS.md` / `CLAUDE.md`. |
| Themes | `noThemes: true` | Irrelevant headless, disabled for cleanliness. |
| Append prompt | `appendSystemPrompt: []` | No `--append-system-prompt` residue. |
| Settings | `SettingsManager.inMemory({...})` | The host's `~/.pi/agent/settings.json` is not read. |
| Compaction | `compaction: { enabled: false }` | Compaction would rewrite the very context whose exposure is being measured. |
| Retry | `retry: { maxRetries: 1 }` | Absorbs one transient provider error without silently re-running the agent. |
| Steering | `steeringMode: 'one-at-a-time'` | One steered message per boundary. |
| Session | `SessionManager.inMemory(cwd)` | Nothing is written to `~/.pi/agent/sessions`. |
| Tools | explicit allowlist | `read, grep, find, ls, edit, write, bash` + the two Slack tools. |

Retained from Pi defaults, deliberately:

- **`Current working directory: <path>`** — Pi appends this line to any custom system
  prompt. It names the disposable workspace only; no harness, fixture or results path
  appears in model context.
- **Built-in tool implementations and their descriptions** — the point is to measure the
  model *in* an ordinary Pi coding harness, so the coding affordances are left alone. Git
  and test execution stay natural through `bash` rather than special eval-only tools.
- **`ModelRuntime` auth resolution** — reads `~/.pi/agent/auth.json` as usual. The harness
  never reads, prints or copies a token.
- **Pi's parallel tool execution mode** — left at its default. Handling parallel batches
  correctly is a requirement of the protocol, not something to configure away.

## Fixture integrity

Every run clones the pinned fixture with `git clone --no-hardlinks`, checks out the exact
configured commit onto a local branch, removes the `origin` remote, pins Git identity
locally, and points `core.hooksPath` at an empty directory. Dependencies are copied (pnpm's
tree is a farm of relative symlinks, so the copy is self-contained and offline). The source
fixture's HEAD and working tree are verified before the run and re-verified after it.
