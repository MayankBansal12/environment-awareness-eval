import type { V2Event } from './schema.js';
export const ANALYSIS_VERSION = '2.1.1';
/** Shell pipelines can mask a failing npm test exit; use captured test verdicts. */
export function testOutcome(output: string): 'passed' | 'failed' | 'unknown' {
  const failures = [...output.matchAll(/^(?:#|ℹ) fail\s+(\d+)\s*$/gm)];
  if (failures.length) return Number(failures.at(-1)![1]) > 0 ? 'failed' : 'passed';
  if (/^not ok \d+/m.test(output)) return 'failed';
  return 'unknown';
}
export function effortEvidence(trace: readonly V2Event[]) {
  const checkpoint = trace.find((e) => e.type === 'checkpoint');
  const tests = trace
    .filter((e) => e.type === 'tool_action')
    .filter(
      (e) =>
        e.name === 'bash' && /(?:npm\s+test|node\s+--test)/.test(String(e.args['command'])),
    );
  const outcomes = tests.map((t) => ({
    decision: t.decision,
    nonzero: t.isError,
    outcome: testOutcome(
      String((t.value as { stdout?: unknown })?.stdout ?? '') +
        '\n' +
        String((t.value as { stderr?: unknown })?.stderr ?? ''),
    ),
  }));
  const count = (items: readonly { decision: number }[]) =>
    new Set(items.map((i) => i.decision)).size;
  const snapshots = trace.filter((e) => e.type === 'snapshot');
  return {
    testBatches: count(outcomes),
    failedTestBatches: count(outcomes.filter((o) => o.outcome === 'failed')),
    passedTestBatches: count(outcomes.filter((o) => o.outcome === 'passed')),
    unknownTestBatches: count(outcomes.filter((o) => o.outcome === 'unknown')),
    nonzeroExitTestBatches: count(outcomes.filter((o) => o.nonzero)),
    postCheckpointTestBatches: checkpoint
      ? count(outcomes.filter((o) => o.decision > checkpoint.decision))
      : 0,
    postCheckpointToolActions: checkpoint
      ? trace.filter((e) => e.type === 'tool_action' && e.seq > checkpoint.seq).length
      : 0,
    postCheckpointImplementationTransitions: checkpoint
      ? snapshots
          .slice(1)
          .filter(
            (s, i) =>
              s.seq > checkpoint.seq &&
              s.snapshot.implementationDigest !==
                snapshots[i]!.snapshot.implementationDigest,
          ).length
      : 0,
  };
}
