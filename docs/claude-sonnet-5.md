# Sonnet 5 eval

Selecting `--provider anthropic --model claude-sonnet-5` runs the installed **Claude Code
agent** exactly like [Opus 5](claude-opus-5.md): through the official Agent SDK, one session
per run, controlled tools over one in-process MCP server, hook-context delivery, the 8,192
token recap and budgets, and the same integrity-sealed audit. Do not substitute a Pi-hosted
transport; the model selection is exact.

## Setup and run

Install Claude Code 2.1.266 or newer and log in with `claude auth login`, then:

```sh
pnpm eval verify-model --provider anthropic --model claude-sonnet-5
pnpm eval run --family settlement --load high --noise normal --delivery ambient --seed 1 --provider anthropic --model claude-sonnet-5
```

`--thinking default` is optional and uses Claude Code's default effort. The selection accepts
only the exact `claude-sonnet-5` ID: `matchesRuntimeIdentity` rejects any recorded identity
that was coerced to a different model or thinking level. Claude Code's own fallback policy
stays allowed the same way as for Opus, and the SDK event log (`claude-code.jsonl`) records
the returned model IDs and per-model usage, so any fallback is disclosed in the artifacts.

## Provenance

- `runtime.json` records `agent: claude-code`, `model: claude-sonnet-5`,
  `requested: <selection>`, and `thinking: default`.
- Pi-hosted Claude results (for example `results/opus5-pilot`) remain a separate evidence
  class; never mix them with native Claude Code runs.
- The local synthetic integration test model ID is a placeholder and unrelated to selection;
  run it per [claude-opus-5.md](claude-opus-5.md) with
  `CLAUDE_CODE_INTEGRATION_TEST=1 pnpm exec vitest run tests/claude-code.integration.test.ts`.
