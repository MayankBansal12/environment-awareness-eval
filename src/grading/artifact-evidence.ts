/** Persisted, post-run evidence consumed by deterministic graders. */

import { z } from 'zod';

import { traceEventSchema, type TraceEvent } from '../trace/schema.js';

export const HIDDEN_CHECK_IDS = ['idempotent_retry', 'merchant_scoped_identity'] as const;

export const checkStatusSchema = z.enum(['passed', 'failed', 'not_run', 'error']);
export type CheckStatus = z.infer<typeof checkStatusSchema>;

export const commandCheckSchema = z.object({
  status: checkStatusSchema,
  command: z.string(),
  exitCode: z.number().int().nullable(),
  detail: z.string(),
});
export type CommandCheck = z.infer<typeof commandCheckSchema>;

export const hiddenCheckResultSchema = z.object({
  id: z.enum(HIDDEN_CHECK_IDS),
  status: checkStatusSchema,
  detail: z.string(),
});
export type HiddenCheckResult = z.infer<typeof hiddenCheckResultSchema>;

export const finalWorkspaceEvidenceSchema = z.object({
  headCommit: z.string().min(1),
  commitsAheadOfFixture: z.number().int().nonnegative(),
  commits: z.array(
    z.object({
      hash: z.string().min(1),
      subject: z.string(),
      unixTime: z.number().int(),
    }),
  ),
  workingTreeDirty: z.boolean(),
  statusPorcelain: z.string(),
  /** All committed and uncommitted paths that differ from the pinned fixture. */
  changedFiles: z.array(z.string()).transform((paths) => [...new Set(paths)].sort()),
  trackedSourceDigest: z.string().min(1),
});
export type FinalWorkspaceEvidence = z.infer<typeof finalWorkspaceEvidenceSchema>;

export const artifactReferencesSchema = z.object({
  trace: z.string(),
  summary: z.string(),
  report: z.string(),
  workspaceDiff: z.string().optional(),
});
export type ArtifactReferences = z.infer<typeof artifactReferencesSchema>;

export const persistedRunEvidenceSchema = z
  .object({
    schemaVersion: z.literal(2),
    scenarioId: z.string().min(1),
    expectedFixtureCommit: z.string().min(1),
    trace: z.array(traceEventSchema).min(1),
    finalWorkspace: finalWorkspaceEvidenceSchema,
    visibleTests: commandCheckSchema,
    hiddenChecks: z.array(hiddenCheckResultSchema),
    /** Prefixes are relative POSIX paths. An exact file can be represented as-is. */
    allowedChangedPathPrefixes: z.array(z.string().min(1)).default(['src/', 'tests/']),
    artifacts: artifactReferencesSchema,
  })
  .superRefine((value, ctx) => {
    const seenHidden = new Set<string>();
    for (const [index, check] of value.hiddenChecks.entries()) {
      if (seenHidden.has(check.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['hiddenChecks', index, 'id'],
          message: `duplicate hidden check result: ${check.id}`,
        });
      }
      seenHidden.add(check.id);
    }

    let previousDecision = -1;
    let previousAction = 0;
    for (const [index, event] of value.trace.entries()) {
      if (event.seq !== index) {
        ctx.addIssue({
          code: 'custom',
          path: ['trace', index, 'seq'],
          message: `trace sequence must be contiguous from zero; expected ${index}, received ${event.seq}`,
        });
      }
      if (event.decisionIndex < previousDecision) {
        ctx.addIssue({
          code: 'custom',
          path: ['trace', index, 'decisionIndex'],
          message: 'trace decision indices must be monotonic',
        });
      }
      if (event.logicalActionIndex < previousAction) {
        ctx.addIssue({
          code: 'custom',
          path: ['trace', index, 'logicalActionIndex'],
          message: 'trace logical action indices must be monotonic',
        });
      }
      previousDecision = event.decisionIndex;
      previousAction = event.logicalActionIndex;
    }

    const start = value.trace.filter((event) => event.type === 'run_start');
    if (start.length !== 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['trace'],
        message: `trace must contain exactly one run_start event; received ${start.length}`,
      });
    } else if (start[0]?.scenarioId !== value.scenarioId) {
      ctx.addIssue({
        code: 'custom',
        path: ['scenarioId'],
        message: 'scenarioId does not match trace run_start',
      });
    }
  });

export type PersistedRunEvidence = z.infer<typeof persistedRunEvidenceSchema>;
export type PersistedRunEvidenceInput = z.input<typeof persistedRunEvidenceSchema>;

export function parsePersistedRunEvidence(input: unknown): PersistedRunEvidence {
  return persistedRunEvidenceSchema.parse(input);
}

/** Parse the append-only trace artifact without accepting blank or malformed lines. */
export function parseTraceJsonl(text: string): TraceEvent[] {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  if (lines.length === 0) throw new Error('trace.jsonl is empty');

  return lines.map((line, index) => {
    if (line.trim().length === 0) {
      throw new Error(`trace.jsonl contains a blank line at ${index + 1}`);
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(line);
    } catch (error) {
      throw new Error(`trace.jsonl line ${index + 1} is not valid JSON`, { cause: error });
    }
    return traceEventSchema.parse(decoded);
  });
}

export function isChangedPathAllowed(path: string, prefixes: readonly string[]): boolean {
  const normalized = path.replaceAll('\\', '/').replace(/^\.\//, '');
  return prefixes.some((prefix) => {
    const normalizedPrefix = prefix.replaceAll('\\', '/').replace(/^\.\//, '');
    return normalizedPrefix.endsWith('/')
      ? normalized.startsWith(normalizedPrefix)
      : normalized === normalizedPrefix;
  });
}
