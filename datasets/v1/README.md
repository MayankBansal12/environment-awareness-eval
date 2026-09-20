# Environment awareness dataset v1

336 unique, audit-valid sessions that ended normally, selected from seven models.
The website preserves behavioral failures and timing-unassessable cases. A valid
run is usable evidence, not necessarily successful adaptation.

| Model | Sessions |
| --- | ---: |
| Claude Opus 5 | 40 |
| Claude Sonnet 5 | 40 |
| GPT-6 Astra | 70 |
| GPT-5.6 Sol | 70 |
| GLM 5.3 Flash | 40 |
| Muse Spark 1.3 Contributor | 40 |
| DeepSeek v4.1 Flash | 36 |

## Scope and exclusions

The initial four-model scenario study contributes 160 sessions. The native Codex
interruption/control study contributes another 60. The three Pi/OpenCode Go
campaigns contribute 116 normally completed sessions. Their matrices and harnesses
are different; these are not 336 independent scenarios or a controlled seven-model
ranking. Each scenario/family/configuration cell has repeated sessions.

`selection.json` identifies the exact original directories, summary hashes, model,
condition and grader version. Sessions reused across campaigns appear once.
Excluded from this website are provider errors, interrupted attempts, older pilots,
and three DeepSeek sessions ending at the per-response token cap. One additional
DeepSeek trial never completed because of its provider usage limit. These exclusions
are not behavioral successes and do not disappear from the original evidence.

Scenarios: requirement updates, task cancellation, urgency downgrade, and delayed
relevance. Most sessions use high-load fixtures, normal noise and ambient delivery;
the 60-session interruption study includes actionable-only, mixed, and noise-only
controls. Use each run's recorded condition. Pi Go uses explicit high reasoning;
native-agent defaults and execution semantics differ and are recorded in runtime
metadata. Existing graded outcomes are preserved, not recomputed during export.

58 sessions in the original 220-session studies were unassessable for their intended
behavioral outcome. Further Pi sessions can also be unassessable. Unfinished-work
and response-opportunity conditions must be checked before interpreting success or
failure. Remaining source bugs are a workload proxy, not proof of cognitive load.
No claim of universal blindness, remembering, or deliberate disobedience follows
from a score alone. The additional three-model behavioral review is still pending.

## Captured evidence and privacy

The downloadable website dataset contains each selected summary, chronological
trace, captured inputs/outputs, tool activity, environment events and exposed
reasoning, with repeated context messages deduplicated. These are harness captures,
not guaranteed complete provider wire transcripts or undisclosed internal reasoning.
Text/argument capture is capped at 24,000 characters and redaction/truncation flags
remain visible. Native Codex and Claude Code have different capture boundaries.

Original artifacts remain unchanged. The public projection replaces the originating
user's home-directory prefix with `[host-home]`. Native SDK wire logs, authentication
configuration and complete event-time source trees are not part of the website
archive. Some historical supplementary Claude SDK records are malformed; standard
trace/context records used by this export parse. Artifact hashes in summaries refer
to original evidence, not the transformed public projection.

## Release and deployment

`dataset.json` pins the GitHub repository, release, asset name, byte count and SHA-256.
The generated `viewer-dataset-v1.json.gz` is a GitHub Release attachment, not a Git
source file. The separate `evidence-v1.tar.gz` attachment preserves the original selected run
artifacts for audit/research; it is not downloaded by the website build. Both asset
checksums are recorded in `dataset.json` and the release `SHA256SUMS` attachment.
Original local evidence and generated assets are ignored by Git.

A clean deployment runs `pnpm build`. It downloads the pinned release, verifies its
checksum and count, expands JSON into `viewer/public/data`, then builds `viewer/dist`.
For the private repository, set `DATASET_GITHUB_TOKEN` as a build-only environment
variable with read access to repository contents. Never use a `VITE_` prefix for it.
The token is not included in browser assets. All included website data is accessible
to visitors of the deployed site.

For an offline/local archive, set `EAW_DATASET_ARCHIVE` to its absolute path before
`pnpm build`. `pnpm viz` remains the local-results viewer and reads `results/`.
To reproduce the archive from the original evidence: `pnpm dataset:export`.
The export's new generation timestamp produces a new archive checksum; publish a
new release/version for future data, rather than silently replacing a pinned asset.
