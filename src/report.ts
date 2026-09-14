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

**Termination:** ${s.termination.reason} — ${s.termination.detail}
**Valid:** ${g.valid} · **Censored:** ${g.censored} · **Duration:** ${minutes} min

## Cost and tokens

| Calls | Input | Cache read | Cache write | Output | Reasoning | Total tokens | Peak context | Cost (USD, catalog pricing) |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| ${u.calls} (${u.summaryCalls} summary, ${u.erroredCalls} errored) | ${u.input} | ${u.cacheRead} | ${u.cacheWrite} | ${u.output} | ${u.reasoning} | ${u.totalTokens} | ${u.peakContextTokens} | ${u.costUsd.total.toFixed(4)} |

## Updates

Latency counts decisions after the first input that showed the unread indicator.

| Update | Fired | Focal checks failing then | Context tokens then | Cue | Content | Latency | Focal edits before content | Commits before content | Final behavior correct |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
${rows}

Noise events: ${cell(g.summary['noiseEvents'])}

## Urgent work

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
