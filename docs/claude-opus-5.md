# Claude Code eval

Selecting `--provider anthropic --model claude-opus-5` (or `claude-sonnet-5`, see
[claude-sonnet-5.md](claude-sonnet-5.md)) runs the installed **Claude Code agent** through the
official Agent SDK. Claude Code owns authentication, the agent loop, reasoning, retries,
compaction, and fallback behavior.

## Setup and run

Install Claude Code **2.1.266 or newer**, log in using `claude auth login`, then:

```sh
pnpm install
pnpm eval verify-model --provider anthropic --model claude-opus-5
pnpm eval run --family settlement --load high --noise normal --delivery ambient --seed 1 --provider anthropic --model claude-opus-5
```

`verify-model` checks the installed CLI and login without inference. It does not check
remaining quota. `--thinking default` is optional and uses Claude Code's default effort.
Fallback is allowed; the SDK event log records the returned model IDs and per-model usage.

## How it connects to the eval

- One native Claude Code session receives the eval's neutral prompt.
- The existing repository, Linear, and Slack tools are exposed through one in-process MCP
  server. Repository commands still execute inside the existing bubblewrap sandbox.
- Built-in tools, skills, user/project settings, and extra MCP servers are disabled for
  this session so all agent actions go through the eval's controlled tools.
- `PostToolBatch` settles the entire tool batch, snapshots the repository, fires due
  updates, and delivers the next environment indicator through hook context. The initial
  indicator is delivered through `UserPromptSubmit`. Older indicators remain in Claude
  Code's history; its native compaction manages that history.
- The 8,192-token output cap and run timeout remain enabled. `--no-compaction` disables
  native automatic compaction. The token guard observes streamed main-loop responses;
  final totals include internal calls when Claude Code supplies its result. Retry policy
  is managed by Claude Code rather than Pi's `providerRetries` setting.

The usual reports and audit artifacts are produced, plus `claude-code.jsonl` containing
the SDK events. `runtime.json` identifies `agent: claude-code`. `context.jsonl` captures
delivered hook context and assistant output, not Claude Code's complete internal prompt
or compaction summaries. Final token/cost totals use the SDK's per-model accounting;
call counts cover visible main-loop responses only, and cost component breakdowns are
unavailable. Costs are estimates, not proof of incremental subscription charges.

## Local integration test

```sh
CLAUDE_CODE_INTEGRATION_TEST=1 pnpm exec vitest run tests/claude-code.integration.test.ts
```

This launches the real Claude Code binary against a local synthetic API, exercising MCP
tools, multi-tool batch boundaries, both delivery modes, auditing, and the token guard.
It uses a dummy key and makes no paid inference requests.

The earlier `results/opus5-pilot` runs and
[connectivity record](claude-opus-5-connectivity.json) used Pi-hosted Opus. They are
historical evidence for that older integration, not Claude Code results.
