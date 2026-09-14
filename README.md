# environment-awareness-eval

Does a coding agent notice and act on workplace updates while it is busy debugging, and does that
get worse as the work gets harder?

An agent (Pi harness + model) gets a sandboxed repository, a simulated Linear and Slack, and a
neutral prompt. While it works, the environment pushes requirement changes, an urgent hotfix, a
buried comment and a decoy opinion, often right after a failing test run, mixed with seeded noise.
Focal difficulty (2, 4 or 7 interacting bugs) is the load manipulation. See
[docs/environment.md](docs/environment.md).

## Setup

Node.js ≥ 22.19, pnpm, `bwrap` with unprivileged user namespaces, and an authenticated Pi provider.

```sh
pnpm install
pnpm eval calibrate        # fixtures, injected bugs and reference solutions; no inference
```

## Run

```sh
M="--provider openai-codex --model gpt-6-astra --thinking medium"

pnpm eval run --family settlement --load high $M                           # one run
pnpm eval freeze experiments/sweep.json sweep load-sweep --reps 3 --seed 1 $M
pnpm eval execute experiments/sweep.json
pnpm eval compare experiments/sweep.json                                   # results/sweep/comparison.md
```

Each run writes `results/…/<run>/` with `report.md` (update detection, outcome, tokens and cost),
`summary.json`, `trace.jsonl`, `context.jsonl`, `usage.json` and an integrity-sealed audit.

## Develop

```sh
pnpm typecheck && pnpm test && pnpm format:check
```

Earlier tracks (v0–v3), the results viewer and their reports are preserved at tag
`archive/pre-v4-cleanup`.
