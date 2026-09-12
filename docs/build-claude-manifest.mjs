// Builds docs/sept10-claude-manifest.json from result artifacts.
// Run: node docs/build-claude-manifest.mjs <runId> [<runId> ...]
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';

const ids = process.argv.slice(2);
if (ids.length === 0) {
  console.error('usage: node docs/build-claude-manifest.mjs <runId> [<runId> ...]');
  process.exit(1);
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
function traceTimes(path) {
  const rows = readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const times = rows.map((r) => r.wallClockIso).filter(Boolean);
  const start = times[0];
  const end = times[times.length - 1];
  return {
    startUtc: start,
    endUtc: end,
    traceDurationSeconds: Number(((new Date(end) - new Date(start)) / 1000).toFixed(3)),
    traceRows: rows.length,
    decisions: new Set(rows.filter((r) => r.type === 'decision_boundary').map((r) => r.decisionIndex)).size,
    assistantTurns: rows.filter((r) => r.type === 'assistant_turn').length,
  };
}
function readFinalText(path) {
  const rows = readFileSync(path, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const term = rows.find((r) => r.type === 'termination');
  return term?.finalAssistantText ?? null;
}
function nativeStats(path) {
  let malformedSkips = 0, bridgeErrors = [], mcpToolCalls = 0, reconnects = 0, version = null;
  for (const line of readFileSync(path, 'utf8').trim().split('\n')) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const r = o.record ?? o;
    if (r.skippedMalformedToolInput) malformedSkips += r.skippedMalformedToolInput.length ?? 1;
    if (r.bridgeError) bridgeErrors.push(r.bridgeError);
    if (r.mcpRequest?.method === 'tools/call') mcpToolCalls += 1;
    if (r.mcpRequest?.method === 'initialize') reconnects += 1;
    if (r.runtime === 'claude-code' && r.version) version = r.version;
  }
  return { malformedSkips, bridgeErrors, mcpToolCalls, mcpReinitialises: reconnects, runtimeVersion: version };
}

const runs = ids.map((runId) => {
  const dir = `results/${runId}`;
  const summary = JSON.parse(readFileSync(`${dir}/summary.json`, 'utf8'));
  const t = traceTimes(`${dir}/trace.jsonl`);
  const n = nativeStats(`${dir}/claude-native.jsonl`);
  const artifacts = {};
  for (const f of ['trace.jsonl', 'summary.json', 'workspace.diff', 'report.md', 'context.jsonl', 'claude-native.jsonl']) {
    try {
      artifacts[f] = { path: `${dir}/${f}`, bytes: statSync(`${dir}/${f}`).size, sha256: sha256(`${dir}/${f}`) };
    } catch { /* absent */ }
  }
  return {
    runId,
    scenario: summary.scenarioId,
    runtime: summary.runtime,
    termination: summary.termination,
    valid: summary.grade.valid,
    classification: summary.grade.classification,
    validity: summary.grade.validity,
    outcome: summary.grade.outcome,
    metrics: summary.grade.metrics,
    visibleTests: summary.visibleTests,
    hiddenChecks: summary.hiddenChecks,
    finalWorkspace: summary.finalWorkspace,
    capture: summary.capture,
    trace: t,
    native: n,
    finalAssistantText: readFinalText(`${dir}/trace.jsonl`),
    timing: { startUtc: t.startUtc, endUtc: t.endUtc, traceDurationSeconds: t.traceDurationSeconds },
    artifacts,
  };
});

const manifest = {
  builtAtUtc: new Date().toISOString(),
  integration: {
    runtime: 'claude-code CLI (native session, controlled MCP bridge)',
    claudeCliVersion: runs[0]?.native.runtimeVersion ?? null,
    harnessLaunchCommit: 'b8e54bd0f3fada91c558e5d1707bfc8a3087d5b1',
    harnessVersion: '0.2.0',
    sourceSha256: Object.fromEntries(
      [
        'src/claude/adapter.ts',
        'src/claude/protocol.ts',
        'src/runner.ts',
        'src/engine/experiment.ts',
        'src/grading/grader.ts',
        'src/cli.ts',
        'src/pi/adapter.ts',
        'src/trace/schema.ts',
        'tests/claude-adapter.test.ts',
        'docs/build-claude-manifest.mjs',
      ].map((p) => [p, sha256(p)]),
    ),
  },
  runs,
};
writeFileSync('docs/sept10-claude-manifest.json', JSON.stringify(manifest, null, 2) + '\n');
console.log('wrote docs/sept10-claude-manifest.json with', runs.length, 'runs');
