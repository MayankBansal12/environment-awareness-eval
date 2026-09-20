import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function fixture(key = 'batch/run-1', validHash = true) {
  const root = await mkdtemp(path.join(tmpdir(), 'dataset-download-'));
  roots.push(root);
  await mkdir(path.join(root, 'viewer/scripts'), { recursive: true });
  await mkdir(path.join(root, 'datasets/v1'), { recursive: true });
  await copyFile(
    fileURLToPath(new URL('../scripts/download-dataset.mjs', import.meta.url)),
    path.join(root, 'viewer/scripts/download-dataset.mjs'),
  );
  const archive = gzipSync(
    JSON.stringify({
      version: 1,
      index: { runs: [{ key }] },
      runs: [
        {
          key,
          summary: {
            grade: { valid: true, censored: false },
            termination: { reason: 'agent_finished' },
          },
        },
      ],
    }),
  );
  const archivePath = path.join(root, 'dataset.gz');
  await writeFile(archivePath, archive);
  await writeFile(
    path.join(root, 'datasets/v1/dataset.json'),
    JSON.stringify({
      sessions: 1,
      bytes: archive.length,
      sha256: validHash
        ? createHash('sha256').update(archive).digest('hex')
        : '0'.repeat(64),
    }),
  );
  return {
    root,
    run: () =>
      execFileSync(
        process.execPath,
        [path.join(root, 'viewer/scripts/download-dataset.mjs')],
        { env: { ...process.env, EAW_DATASET_ARCHIVE: archivePath }, stdio: 'pipe' },
      ),
  };
}
describe('published dataset installation', () => {
  it('installs an intact pinned dataset into the static viewer directory', async () => {
    const f = await fixture();
    f.run();
    expect(
      JSON.parse(await readFile(path.join(f.root, 'viewer/public/data/index.json'), 'utf8'))
        .runs,
    ).toHaveLength(1);
    expect(
      JSON.parse(
        await readFile(
          path.join(f.root, 'viewer/public/data/runs/batch/run-1.json'),
          'utf8',
        ),
      ).key,
    ).toBe('batch/run-1');
  });
  it('rejects corrupt archives before touching the existing dataset', async () => {
    const f = await fixture('batch/run-1', false);
    await mkdir(path.join(f.root, 'viewer/public/data'), { recursive: true });
    await writeFile(path.join(f.root, 'viewer/public/data/index.json'), 'preserve');
    expect(f.run).toThrow();
    expect(await readFile(path.join(f.root, 'viewer/public/data/index.json'), 'utf8')).toBe(
      'preserve',
    );
  });
  it('rejects run keys that would escape the data directory', async () => {
    const f = await fixture('../outside');
    expect(f.run).toThrow();
  });
});
