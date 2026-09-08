import { describe, expect, it } from 'vitest';
import { BlobInterner, loadContextBundle } from '../src/derive/context-load.js';

const flags = { truncated: false, chars: 4, redacted: false };
const message = {
  role: 'user',
  text: 'same',
  blocks: [{ kind: 'text', text: 'same', ...flags }],
  ...flags,
  omitted: false,
};
function records(): Record<string, any>[] {
  return [
    {
      schemaVersion: 2,
      type: 'capture_header',
      runId: 'r',
      provider: 'p',
      model: 'm',
      thinkingLevel: 'off',
      systemPrompt: 'same',
      systemPromptSource: 'runtime_session',
      harnessSystemPrompt: 'same',
      initialUserPrompt: 'same',
      toolDefinitions: [],
      settings: {},
      redacted: false,
    },
    {
      schemaVersion: 2,
      type: 'call_input',
      decisionIndex: 0,
      wallClockIso: 'now',
      capturedModelContext: [structuredClone(message)],
      messageCount: 1,
    },
    {
      schemaVersion: 2,
      type: 'call_output',
      decisionIndex: 0,
      turnIndex: 0,
      wallClockIso: 'now',
      text: 'same',
      textCapture: flags,
      stopReason: 'stop',
      toolCalls: [],
    },
    {
      schemaVersion: 2,
      type: 'capture_audit',
      runId: 'r',
      headerWritten: true,
      inputCount: 1,
      outputCount: 1,
      traceDecisionCount: 1,
      decisionsMissingInput: [],
      decisionsMissingOutput: [],
      failures: [],
      failureCount: 0,
      truncatedMessageCount: 0,
      redactedMessageCount: 0,
      omittedBlockMessageCount: 0,
      complete: true,
      note: '',
    },
  ];
}
function load(rows: unknown[], interner = new BlobInterner()) {
  return loadContextBundle(rows.map((r) => JSON.stringify(r)).join('\n'), {
    traceDecisionCount: 1,
    traceDecisions: [{ decisionIndex: 0, contextMessageCount: 1 }],
    interner,
  });
}
describe('context sidecar fidelity', () => {
  it('interns repeated input, blocks, header and output across runs', () => {
    const interner = new BlobInterner();
    const a = load(records(), interner),
      b = load(records(), interner);
    expect(a.fidelity).toMatchObject({ level: 'full', limitations: [] });
    const ref = a.calls[0]!.input!.messages[0]!.textRef;
    expect(a.header!.systemPromptRef).toBe(ref);
    expect(a.calls[0]!.output!.textRef).toBe(ref);
    expect(b.calls[0]!.input!.messages[0]!.blocks![0]).toMatchObject({ ref });
    expect(interner.size).toBe(1);
    expect(interner.table()[ref]).toBe('same');
  });
  it('labels absent, empty and malformed captures separately', () => {
    const options = { traceDecisionCount: 1, interner: new BlobInterner() };
    expect(loadContextBundle(null, options).fidelity.level).toBe('none');
    expect(loadContextBundle('', options).fidelity.level).toBe('unreadable');
    expect(loadContextBundle('{broken', options).fidelity.level).toBe('unreadable');
    expect(load([{ schemaVersion: 2, type: 'capture_header' }]).fidelity.level).toBe(
      'unreadable',
    );
  });
  it('reads v1 text with explicit missing structure', () => {
    const rows: Record<string, any>[] = records()
      .slice(0, 3)
      .map((row) => ({ ...row, schemaVersion: 1 }));
    delete rows[1]!['capturedModelContext'][0].blocks;
    delete rows[0]!['systemPromptSource'];
    const bundle = load(rows);
    expect(bundle.fidelity.level).toBe('partial');
    expect(bundle.calls[0]!.input!.messages[0]!.blocks).toBeNull();
    expect(bundle.fidelity.limitations.join(' ')).toContain('v1 records');
  });
  it.each([0, 1, 2, 3])('rejects duplicate record %i as full evidence', (index) => {
    const rows = records();
    rows.push(rows[index]!);
    const bundle = load(rows);
    expect(bundle.fidelity.level).toBe('partial');
    expect(bundle.fidelity.limitations.join(' ')).toContain('duplicate');
  });
  it.each([
    'unknown',
    'bad-version',
    'bad-input',
    'missing-half',
    'missing-audit',
    'bad-count',
    'bad-id',
    'bad-message-count',
    'bad-audit',
    'incomplete',
    'run-id',
    'failure-count',
  ])('reports %s without claiming full capture', (kind) => {
    const rows = records();
    if (kind === 'unknown') rows.push({ schemaVersion: 2, type: 'new_record' });
    if (kind === 'bad-version') rows[1]!.schemaVersion = 99;
    if (kind === 'bad-input') rows[1]!.capturedModelContext[0].text = 42;
    if (kind === 'missing-half') rows.splice(2, 1);
    if (kind === 'missing-audit') rows.pop();
    if (kind === 'bad-count') rows[3]!.inputCount = 3;
    if (kind === 'bad-id') {
      rows[1]!.decisionIndex = 8;
      rows[2]!.decisionIndex = 8;
    }
    if (kind === 'bad-message-count') rows[1]!.messageCount = 2;
    if (kind === 'bad-audit') rows[3]!.decisionsMissingOutput = [0];
    if (kind === 'incomplete') rows[3]!.complete = false;
    if (kind === 'run-id') rows[3]!.runId = 'other';
    if (kind === 'failure-count')
      rows[3]!.failures = [{ stage: 'call_input', decisionIndex: 0, message: 'failure' }];
    expect(load(rows).fidelity.level).toBe('partial');
  });
  it.each([
    'truncated',
    'redacted',
    'omitted',
    'image',
    'unsupported',
    'thinking',
    'tool',
    'output',
    'output-redaction',
    'missing-output-flags',
    'header',
    'block-truncated',
    'block-redacted',
    'text-redacted',
    'reasoning-redacted',
    'argument-depth',
  ])('reports %s content loss independently of the audit', (kind) => {
    const rows = records(),
      msg = rows[1]!.capturedModelContext[0];
    if (['truncated', 'redacted', 'omitted'].includes(kind)) msg[kind] = true;
    if (kind === 'image')
      msg.blocks = [
        { kind: 'image', mimeType: 'image/png', dataChars: 8, payloadOmitted: true },
      ];
    if (kind === 'unsupported')
      msg.blocks = [
        {
          kind: 'unsupported',
          blockType: 'audio',
          keys: [],
          note: 'omitted',
          payloadOmitted: true,
        },
      ];
    if (kind === 'thinking')
      msg.blocks = [{ kind: 'thinking', text: '', ...flags, providerRedacted: true }];
    if (kind === 'tool')
      rows[2]!.toolCalls = [
        { id: 't', name: 'write', arguments: {}, truncatedArguments: ['text'] },
      ];
    if (kind === 'output') rows[2]!.textCapture = { ...flags, truncated: true };
    if (kind === 'output-redaction') rows[2]!.reasoningRedacted = true;
    if (kind === 'missing-output-flags') delete rows[2]!.textCapture;
    if (kind === 'header') rows[0]!.redacted = true;
    if (kind === 'block-truncated') msg.blocks[0].truncated = true;
    if (kind === 'block-redacted') msg.blocks[0].redacted = true;
    if (kind === 'text-redacted') rows[2]!.textCapture = { ...flags, redacted: true };
    if (kind === 'reasoning-redacted') {
      rows[2]!.reasoningText = 'same';
      rows[2]!.reasoningCapture = { ...flags, redacted: true };
    }
    if (kind === 'argument-depth')
      rows[2]!.toolCalls = [
        {
          id: 't',
          name: 'write',
          arguments: {},
          truncatedArguments: [],
          depthCapped: true,
        },
      ];
    // A consistent audit must not hide content loss behind its successful bookkeeping.
    rows[3]!.truncatedMessageCount = Number(msg.truncated);
    rows[3]!.redactedMessageCount = Number(msg.redacted);
    rows[3]!.omittedBlockMessageCount = Number(msg.omitted);
    const result = load(rows);
    expect(result.fidelity.level).toBe('partial');
    expect(result.fidelity.limitations.join(' ')).not.toContain('counts disagree');
  });
  it('rejects a mutually consistent sidecar belonging to another trace run', () => {
    const raw = records()
      .map((row) => JSON.stringify(row))
      .join('\n');
    const result = loadContextBundle(raw, {
      traceDecisionCount: 1,
      expectedRunId: 'another',
      interner: new BlobInterner(),
    });
    expect(result.fidelity.level).toBe('partial');
    expect(result.fidelity.limitations).toContain(
      'capture belongs to a different run than its trace.',
    );
  });
  it('checks trace message counts and noncontiguous decision IDs', () => {
    const rows = records();
    rows[1]!.decisionIndex = 7;
    rows[2]!.decisionIndex = 7;
    const raw = rows.map((r) => JSON.stringify(r)).join('\n');
    const options = {
      traceDecisionCount: 1,
      traceDecisions: [{ decisionIndex: 7, contextMessageCount: 1 }],
      interner: new BlobInterner(),
    };
    expect(loadContextBundle(raw, options).fidelity.level).toBe('full');
    options.traceDecisions[0]!.contextMessageCount = 3;
    expect(loadContextBundle(raw, options).fidelity.level).toBe('partial');
  });
});
