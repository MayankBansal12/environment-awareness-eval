import { checkSchema } from './schema.js';
import { HIDDEN_CHECK_IDS, HIDDEN_PROBES } from './fixture.js';
import type { RunSandbox } from './sandbox.js';
export async function functionalChecks(sandbox: RunSandbox) {
  const visible = await sandbox.exec(['npm', 'test'], { readOnly: true });
  const hidden = await sandbox.exec(['node', '--input-type=module'], {
    stdin: HIDDEN_PROBES,
    readOnly: true,
  });
  let checks;
  try {
    if (hidden.exitCode !== 0 || hidden.truncated)
      throw Error(hidden.stderr || 'Probe execution failed');
    checks = checkSchema.array().parse(JSON.parse(hidden.stdout));
    if (
      JSON.stringify(checks.map((c) => c.id).sort()) !==
      JSON.stringify([...HIDDEN_CHECK_IDS].sort())
    )
      throw Error('Incomplete or duplicate probe results');
  } catch (error) {
    checks = [{ id: 'probe_execution', passed: false, detail: String(error) }];
  }
  return {
    hiddenChecks: checks,
    visibleTests: {
      passed: visible.exitCode === 0 && !visible.truncated,
      output: visible.stdout + visible.stderr,
    },
  };
}
