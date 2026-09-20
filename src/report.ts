import type { Summary } from './schema.js';

const cell = (v: unknown) => (v === null || v === undefined ? '—' : String(v));

export function renderReport(s: Summary): string {
  const u = s.usage,
    c = s.condition,
    g = s.grade;
  const minutes = (s.durationMs / 60000).toFixed(1);
  const rows = g.events
    .map(
      (e) =>
        `| ${e.kind} | ${e.fired ? `D${e.firedDecision} (${e.trigger}${e.firedDuringTestFailure ? ', during test failure' : ''})` : 'not fired'} | ${cell(e.focalChecksFailingAtFire)} | ${cell(e.contextTokensAtFire)} | ${cell(e.cueDecision)} | ${cell(e.contentDecision)} | ${cell(e.detectionLatency)} | ${cell(e.focalChangesBeforeContent)} | ${cell(e.commitsBeforeContent)} | ${cell(e.adapted)} |`,
    )
    .join('\n');
  return `# ${s.runId}

${c.family} · load ${c.load} · noise ${c.noise} · ${c.delivery} · seed ${c.seed}
Model: ${cell(s.runtime['provider'])}/${cell(s.runtime['model'])} · thinking ${cell(s.runtime['thinking'])}
${s.runtime['agent'] === 'claude-code' ? 'Agent: Claude Code · native default effort and fallback behavior\n' : ''}

**Termination:** ${s.termination.reason} — ${s.termination.detail}
**Valid:** ${g.valid} · **Censored:** ${g.censored} · **Duration:** ${minutes} min

## Cost and tokens

| Calls | Input | Cache read | Cache write | Output | Reasoning | Total tokens | Peak context | Cost (USD, catalog pricing) |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ${u.calls} (${u.summaryCalls} summary, ${u.erroredCalls} errored) | ${u.input} | ${u.cacheRead} | ${u.cacheWrite} | ${u.output} | ${u.reasoning} | ${u.totalTokens} | ${u.peakContextTokens} | ${u.costUsd.total.toFixed(4)} |
${s.runtime['agent'] === 'claude-code' ? '\nCall counts cover visible main-loop responses. Internal summary calls are not counted; final token/cost totals include them when Claude Code supplies a result. Cost is Claude Code’s estimate.\n' : ''}

## Updates

Retrieval latency counts decisions from the first recorded input after an event to content retrieval. Retrieval does not prove understanding; final correctness does not prove adaptation or rejection of a decoy.

${
  g.events.some((e) => e.observation)
    ? `| Update | First input after event | Responses after event | Content retrieved | Behavior correct at fire (old contract) | Compactions after retrieval |
| --- | ---: | ---: | --- | --- | ---: |
${g.events
  .filter((e) => e.observation)
  .map(
    (e) =>
      `| ${e.kind} | ${cell(e.observation!.firstInputAfterEvent)} | ${e.observation!.responseDecisions} | ${e.observation!.contentRetrieved} | ${cell(e.observation!.behaviorCorrectAtFire)} | ${cell(e.observation!.compactionsAfterContent)} |`,
  )
  .join('\n')}
`
    : ''
}

| Update | Fired | Focal checks failing then | Context tokens then | Cue retrieved | Content retrieved | Retrieval latency | Focal edits before content | Commits before content | Final behavior correct |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
${rows}

Noise events: ${cell(g.summary['noiseEvents'])}

## Urgent work

Status ordering and edits are descriptive, not automatic priority violations. Review safe stopping points and later ticket reopenings.

${Object.entries(g.urgent)
  .map(([k, v]) => `- ${k}: ${cell(v)}`)
  .join('\n')}

## Outcome

${Object.entries(g.outcome)
  .map(([k, v]) => `- ${k}: ${cell(v)}`)
  .join('\n')}

Validity: ${g.validity.map((v) => `${v.id}=${v.passed}`).join(', ')}
`;
}
