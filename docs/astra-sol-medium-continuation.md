# Astra and Sol medium: fresh Pi attempts

The user authorized a fresh attempt after the original campaigns stopped on provider
usage limits. Both evaluated models use Pi 0.84.4 with `openai-codex` and medium reasoning.
The BB controller threads supervise execution and review; their tools and context are
outside the evaluated sessions.

Workflow `wfr_0c1ef886-e632-43df-afb8-7f557ee99a04` launched on 2026-09-13 UTC
(2026-09-14 in Asia/Kolkata). Completion and result validity must be checked in its
controller reports; a running or successful controller workflow does not establish that
every evaluation trajectory completed.

| Campaign | Fresh trials | Retained evidence |
| --- | --- | --- |
| `astra-medium-v32-cont1` | t002–t006, in original order | Original Astra t001 remains the valid lower-demand sequential baseline |
| `sol-medium-v32-cont1` | t001–t006, in original order | Both original Sol attempts remain separately recorded failures |

This schedules 11 fresh trajectories. Every trajectory starts from a new isolated session
and workspace. Earlier failures remain intact, and no provider-censored checkpoint is
resumed. The user authorized this new campaign; no further replacement campaign or
automatic retry is authorized by this launch plan.

The 60 frozen source-file hashes, source archive contents, prompt, fixtures, model settings,
budgets and selected trial configurations match the originals. The retained Astra baseline
has an eligible saved audit and matching result-receipt hashes, verified before preparing
these manifests. No harness or task changes were needed.

Astra's continuation is an explicit ordered subset of its original six-cell design. Its
manifest uses the existing schema's optional-design form because the full-schedule design
constraint includes the already completed t001. The complete original design, selected and
omitted trial IDs, manifest hashes and source archive hashes are recorded in
[continuation provenance](astra-sol-medium-continuation.json). Sol retains the complete
original design. This selection is based on completion and external provider failures,
not on model success or failure within a valid run.

Each controller verifies Pi access with existing credentials, executes one trial at a time,
and honors the harness halt after any invalid or incomplete attempt, provider error or
functionally failing sequential baseline. Preflight verifies model/catalog access; actual
inference is the capacity check. Each completed attempt gets capture auditing, receipt
verification and a controller artifact review. Reviews are unblinded; second review remains
pending. The parent combines both models only after these reports are available.

Report destinations:

- `docs/astra-medium-v32-cont1-results.md`
- `docs/sol-medium-v32-cont1-results.md`

Interpretation remains limited to a development pilot with one planned observation per
cell. The retained baseline predates this continuation, provider weights are unpinned,
and Pi does not transmit the requested output-token cap for this provider. Keep all
attempts and capture times visible in any combined comparison.
