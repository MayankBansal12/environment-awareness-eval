import path from 'node:path';
import {
  createManifest,
  executeManifest,
  loadManifest,
  writeManifest,
} from './experiment.js';
import { writeComparison } from './comparison.js';
import { auditRun } from './audit.js';
async function main() {
  const [command, ...args] = process.argv.slice(2);
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i],
      value = args[i + 1];
    if (!flag?.startsWith('--') || !value || value.startsWith('--'))
      throw Error('Use --flag value arguments');
    if (values.has(flag)) throw Error('Duplicate argument ' + flag);
    values.set(flag, value);
  }
  const allowed: Record<string, string[]> = {
    freeze: ['--manifest', '--id', '--phase', '--seed', '--repetitions'],
    execute: ['--manifest', '--results', '--max-new-runs'],
    compare: ['--manifest', '--results'],
    audit: ['--run'],
  };
  if (!command || !allowed[command])
    throw Error(
      'Commands: freeze, execute (requires --max-new-runs 1..6), compare, audit. Freeze performs no inference.',
    );
  for (const key of values.keys())
    if (!allowed[command]!.includes(key)) throw Error('Unsupported argument ' + key);
  const get = (k: string) => {
    const v = values.get(k);
    if (!v) throw Error('Required ' + k);
    return v;
  };
  if (command === 'audit') {
    const audit = await auditRun(path.resolve(get('--run')));
    console.log(JSON.stringify(audit, null, 2));
    if (!audit.eligible) process.exitCode = 1;
    return;
  }
  if (command === 'freeze') {
    const phase = get('--phase');
    if (!['calibration', 'experiment', 'development'].includes(phase))
      throw Error('Invalid phase');
    const manifest = await createManifest({
      id: get('--id'),
      phase: phase as 'calibration' | 'experiment' | 'development',
      seed: get('--seed'),
      repetitions: Number(values.get('--repetitions') ?? 3),
    });
    await writeManifest(get('--manifest'), manifest);
    console.log(
      JSON.stringify({
        manifest: get('--manifest'),
        hash: manifest.hash,
        trials: manifest.schedule.length,
        inference: false,
      }),
    );
    return;
  }
  const manifest = await loadManifest(get('--manifest')),
    root = path.resolve(values.get('--results') ?? 'results');
  if (command === 'execute')
    console.log(
      JSON.stringify(
        await executeManifest(manifest, root, Number(get('--max-new-runs'))),
        null,
        2,
      ),
    );
  const report = await writeComparison(manifest, root);
  console.log(
    JSON.stringify({ manifest: report.manifestId, cells: report.cells }, null, 2),
  );
}
main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exitCode = 1;
});
