# Claude Opus 5 integration

## Selection and default reasoning

Use exact `--provider anthropic --model claude-opus-5 --thinking default`.
Omitting `--thinking` for this tuple also selects `default`. Aliases, other Claude
models, and explicit non-default Claude reasoning selections are rejected.

Anthropic's [Opus 5 effort documentation](https://platform.claude.com/docs/en/build-with-claude/effort#recommended-effort-levels-for-claude-opus-5)
explicitly specifies **high** as its API default and states that sending high is
equivalent to omitting effort. Verified against the live documentation on
2026-09-15 UTC. This is resolved independently of the eval's Muse/high default.

Pi 0.84.4 receives `reasoning: high` and sends `thinking: {type: adaptive,
display: summarized}` plus `output_config: {effort: high}`. Omitted reasoning on
summary calls is also resolved to high; it does not disable thinking. The session
uses high, while persisted selection/identity retain `thinking: default` and
record `resolvedThinking`, `thinkingMode`, `effortTransport`, and the documentation
source. This is the **API default**, not a claim about Claude Code's UI effort setting.

The maximum output remains 8,192 tokens, serialized as Anthropic `max_tokens`.
Smaller positive integer caps requested by Pi compaction are honored. Thinking
and response share that output cap. Tests exercise Pi's actual summary builder
(2,560 reserve tokens produces a 2,048-token cap), not just a mocked call.

## Authentication and transport provenance

The runtime first uses native Pi Anthropic authentication (including environment
credentials and native coordinated OAuth refresh), ignoring model/endpoint
overrides from `models.json`. If none is configured, it reads Claude Code's existing
Linux credential at `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.credentials.json`.
The fallback exposes only an in-memory access token to native Pi. It reads anew
at each credential resolution, requires `user:inference` scope and more than five
minutes of validity, and never writes or copies access/refresh tokens. Previously
resolved summary API keys are discarded so summaries also check current expiry.

**Claude Code owns refresh for the read-only bridge.** An expired, missing, or
malformed credential stops inference; refresh the Claude Code login before
restarting, or configure native Pi Anthropic authentication. The bridge does not
rotate refresh tokens or create a second competing OAuth store. Authentication
source is recorded without credential material. Host authentication files remain
outside the agent's bubblewrap sandbox.

Installed Claude Code 2.1.266 was logged in to a first-party Pro subscription.
Native Pi had no Anthropic credential. The read-only Claude Code route passed a
minimal paid request with HTTP 200 and raw server identity `claude-opus-5`.
The credential inspected then expired at 2026-09-16 06:05:39 UTC; readiness must
be rechecked when starting later runs.

Pi 0.84.4 detects OAuth tokens and uses its native Claude Code transport:

- Adds `You are Claude Code, Anthropic's official CLI for Claude.` before the
  supplied system prompt; the supplied prompt is retained verbatim.
- Canonicalizes matching tool names (for example, `read` → `Read`) on the wire and
  maps returned names back to the original tools.
- Uses its native OAuth headers and summarized-thinking capture behavior.

These are provider transport transformations, recorded here rather than hidden
as identical wire prompts across providers. The eval's prompt files, tools,
grading, cases, load, noise and delivery definitions are unchanged. The isolated
connectivity usage is in [claude-opus-5-connectivity.json](claude-opus-5-connectivity.json),
outside `results/`, and is not included in pilot totals. Pricing is a catalog
estimate, not evidence of an incremental subscription charge.

## Parent pilot commands

The following verification command succeeded without inference:

```sh
pnpm eval verify-model --provider anthropic --model claude-opus-5 --thinking default
```

After reviewing the integration, run these once each (not executed by the
integration agent). Default run budgets and compaction stay enabled:

```sh
pnpm eval run --family settlement --load high --noise normal --delivery ambient --seed 1 --provider anthropic --model claude-opus-5 --thinking default --run-id opus5-settlement-high-normal-ambient-1 --results results/opus5-pilot
pnpm eval run --family fulfillment --load high --noise normal --delivery ambient --seed 1 --provider anthropic --model claude-opus-5 --thinking default --run-id opus5-fulfillment-high-normal-ambient-1 --results results/opus5-pilot
pnpm eval audit results/opus5-pilot/opus5-settlement-high-normal-ambient-1
pnpm eval audit results/opus5-pilot/opus5-fulfillment-high-normal-ambient-1
```
