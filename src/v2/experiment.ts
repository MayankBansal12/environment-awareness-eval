import { access, mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { z } from 'zod';
import { VERSION } from '@earendil-works/pi-coding-agent';
import { conditionSchema, demandSchema } from './state.js';
import { fixtureDigest, FIXTURE_VERSION, TASK_FAMILY, TRIGGER_VERSION } from './fixture.js';
import { sourceIdentity, PROJECT_ROOT } from './identity.js';
import { sha256 } from './audit.js';
import { FREE_MODEL, FREE_PROVIDER, ZEN_BASE_URL } from './model.js';
import { runV2, SYSTEM_PROMPT, type V2Config } from './runner.js';

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
export const manifestBodySchema = z
  .object({
    version: z.literal(1),
    id,
    phase: z.enum(['calibration', 'experiment', 'development']),
    seed: z.string(),
    repetitions: z.number().int().min(1).max(100),
    family: z.literal(TASK_FAMILY),
    fixtureVersion: z.literal(FIXTURE_VERSION),
    triggerVersion: z.literal(TRIGGER_VERSION),
    graderVersion: z.enum(['2.1', '2.1.1']),
    auditVersion: z.literal('2.1'),
    fixtureHashes: z.object({ lower: z.string(), higher: z.string() }).strict(),
    sourceHashes: z.record(z.string(), z.string()),
    systemPromptHash: z.string(),
    runtime: z
      .object({
        provider: z.literal(FREE_PROVIDER),
        model: z.literal(FREE_MODEL),
        baseUrl: z.literal(ZEN_BASE_URL),
        api: z.literal('openai-responses'),
        thinking: z.literal('high'),
        maxOutputTokens: z.literal(8192),
        contextWindow: z.literal(131072),
        piVersion: z.string(),
        providerWeightsPinned: z.literal(false),
      })
      .strict(),
    budgets: z
      .object({
        maxTurns: z.number().int().min(1).max(100),
        maxActions: z.number().int().min(1).max(300),
        timeoutMs: z.number().int().min(1000).max(1200000),
      })
      .strict(),
    observationWindow: z.number().int().min(1).max(100),
    schedule: z.array(
      z
        .object({
          id,
          repetition: z.number().int().positive(),
          demand: demandSchema,
          condition: conditionSchema,
        })
        .strict(),
    ),
  })
  .strict();
export const manifestSchema = manifestBodySchema.extend({ hash: z.string() }).strict();
export type Manifest = z.infer<typeof manifestSchema>;
export async function createManifest(options: {
  id: string;
  phase: Manifest['phase'];
  seed: string;
  repetitions?: number;
}): Promise<Manifest> {
  const repetitions = options.repetitions ?? 3;
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 100)
    throw Error('Repetitions must be an integer from 1 to 100');
  const conditions =
    options.phase === 'calibration' ? (['baseline'] as const) : conditionSchema.options;
  let counter = 0;
  const random = () =>
    parseInt(sha256(options.seed + ':' + counter++).slice(0, 8), 16) / 4294967296;
  const shuffle = <T>(a: readonly T[]) => {
    const b = [...a];
    for (let i = b.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [b[i], b[j]] = [b[j]!, b[i]!];
    }
    return b;
  };
  const schedule: Manifest['schedule'] = [];
  for (let repetition = 1; repetition <= repetitions; repetition++)
    for (const condition of shuffle(conditions))
      for (const demand of shuffle(demandSchema.options))
        schedule.push({
          id: 't' + String(schedule.length + 1).padStart(3, '0'),
          repetition,
          demand,
          condition,
        });
  const body = manifestBodySchema.parse({
    version: 1,
    ...options,
    repetitions,
    family: TASK_FAMILY,
    fixtureVersion: FIXTURE_VERSION,
    triggerVersion: TRIGGER_VERSION,
    graderVersion: '2.1.1',
    auditVersion: '2.1',
    fixtureHashes: { lower: fixtureDigest('lower'), higher: fixtureDigest('higher') },
    sourceHashes: await sourceIdentity(),
    systemPromptHash: sha256(SYSTEM_PROMPT),
    runtime: {
      provider: FREE_PROVIDER,
      model: FREE_MODEL,
      baseUrl: ZEN_BASE_URL,
      api: 'openai-responses',
      thinking: 'high',
      maxOutputTokens: 8192,
      contextWindow: 131072,
      piVersion: VERSION,
      providerWeightsPinned: false,
    },
    budgets: { maxTurns: 60, maxActions: 150, timeoutMs: 900000 },
    observationWindow: 5,
    schedule,
  });
  return { ...body, hash: sha256(JSON.stringify(body)) };
}
export function validateManifest(raw: unknown): Manifest {
  const manifest = manifestSchema.parse(raw);
  const { hash, ...body } = manifest;
  if (sha256(JSON.stringify(body)) !== hash) throw Error('Manifest hash mismatch');
  if (new Set(manifest.schedule.map((t) => t.id)).size !== manifest.schedule.length)
    throw Error('Duplicate trial identifiers');
  const cells = manifest.phase === 'calibration' ? ['baseline'] : conditionSchema.options;
  if (manifest.schedule.length !== manifest.repetitions * cells.length * 2)
    throw Error('Incomplete schedule');
  for (let r = 1; r <= manifest.repetitions; r++)
    for (const demand of demandSchema.options)
      for (const condition of cells)
        if (
          manifest.schedule.filter(
            (t) => t.repetition === r && t.demand === demand && t.condition === condition,
          ).length !== 1
        )
          throw Error('Unbalanced schedule');
  return manifest;
}
export async function loadManifest(file: string) {
  return validateManifest(JSON.parse(await readFile(file, 'utf8')));
}
export async function writeManifest(file: string, manifest: Manifest) {
  validateManifest(manifest);
  const files: Record<string, string> = {};
  for (const [name, hash] of Object.entries(manifest.sourceHashes)) {
    if (
      !['package.json', 'pnpm-lock.yaml'].includes(name) &&
      (!name.startsWith('src/') || !name.endsWith('.ts') || name.split('/').includes('..'))
    )
      throw Error('Unsafe source snapshot path');
    const content = await readFile(path.join(PROJECT_ROOT, name), 'utf8');
    if (sha256(content) !== hash) throw Error('Source changed while freezing snapshot');
    files[name] = content;
  }
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  await writeFile(file, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  await writeFile(
    file + '.sources.json.gz',
    gzipSync(JSON.stringify({ version: 1, manifestHash: manifest.hash, files })),
    { flag: 'wx' },
  );
}
async function exists(p: string) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}
export function experimentDir(root: string, manifest: Manifest) {
  return path.resolve(root, manifest.id);
}
export function trialDir(
  root: string,
  manifest: Manifest,
  trial: Manifest['schedule'][number],
) {
  return path.join(experimentDir(root, manifest), 'runs', manifest.id + '-' + trial.id);
}
/** At-most-once trial launch. An incomplete directory is retained and never retried automatically. */
export async function executeManifest(
  manifest: Manifest,
  root: string,
  maxNewRuns: number,
  run: (c: V2Config) => Promise<unknown> = runV2,
) {
  validateManifest(manifest);
  if (!Number.isInteger(maxNewRuns) || maxNewRuns < 1 || maxNewRuns > 6)
    throw Error('Explicit --max-new-runs must be between 1 and 6');
  if (JSON.stringify(await sourceIdentity()) !== JSON.stringify(manifest.sourceHashes))
    throw Error('Manifest source mismatch; freeze a new manifest before inference');
  if (
    manifest.runtime.piVersion !== VERSION ||
    manifest.systemPromptHash !== sha256(SYSTEM_PROMPT) ||
    manifest.fixtureHashes.lower !== fixtureDigest('lower') ||
    manifest.fixtureHashes.higher !== fixtureDigest('higher')
  )
    throw Error('Frozen runtime/fixture mismatch');
  const dir = experimentDir(root, manifest);
  await mkdir(dir, { recursive: true });
  const copy = path.join(dir, 'manifest.json');
  if (await exists(copy)) {
    if ((await loadManifest(copy)).hash !== manifest.hash)
      throw Error('Experiment directory belongs to another manifest');
  } else await writeManifest(copy, manifest);
  const lock = path.join(dir, '.batch.lock');
  const handle = await open(lock, 'wx');
  await handle.writeFile(
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
  );
  await handle.close();
  let launched = 0;
  const results: Array<{ trial: string; status: string; error?: string }> = [];
  try {
    for (const trial of manifest.schedule) {
      const target = trialDir(root, manifest, trial);
      if (await exists(target)) {
        results.push({ trial: trial.id, status: 'retained_existing_attempt' });
        continue;
      }
      if (launched >= maxNewRuns) {
        results.push({ trial: trial.id, status: 'not_started' });
        continue;
      }
      launched++;
      process.stdout.write(
        `Trial ${trial.id}: ${trial.demand}/${trial.condition} (${manifest.phase})\n`,
      );
      try {
        const result = await run({
          runId: manifest.id + '-' + trial.id,
          demand: trial.demand,
          condition: trial.condition,
          resultsDir: path.dirname(target),
          ...manifest.budgets,
          keepWorkspace: false,
          expectedSources: manifest.sourceHashes,
          experiment: {
            manifestHash: manifest.hash,
            phase: manifest.phase,
            trialId: trial.id,
          },
        });
        results.push({ trial: trial.id, status: 'completed' });
        if (
          result &&
          typeof result === 'object' &&
          'grade' in result &&
          (result.grade as { valid: boolean }).valid === false
        )
          break;
      } catch (error) {
        await mkdir(target, { recursive: true });
        await writeFile(
          path.join(target, 'batch-error.json'),
          JSON.stringify(
            { error: String(error), manifestHash: manifest.hash, trialId: trial.id },
            null,
            2,
          ) + '\n',
          { flag: 'wx' },
        );
        results.push({ trial: trial.id, status: 'attempt_error', error: String(error) });
        // A provider/setup error is retained; stop rather than burning the remaining authorization.
        break;
      }
    }
    return { launched, results };
  } finally {
    await unlink(lock);
  }
}
