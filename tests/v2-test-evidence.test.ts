import { describe, it, expect } from 'vitest';
import { effortEvidence, testOutcome } from '../src/v2/test-evidence.js';
import type { V2Event } from '../src/v2/schema.js';
describe('test outcomes survive shell pipelines', () => {
  it('recognizes failed TAP even when the shell returned success', () => {
    const event = {
      type: 'tool_action',
      name: 'bash',
      decision: 8,
      seq: 20,
      isError: false,
      args: { command: 'npm test | tail -n 100' },
      value: { stdout: '# tests 10\n# pass 3\n# fail 7\n', exitCode: 0 },
    } as unknown as V2Event;
    expect(effortEvidence([event])).toMatchObject({
      testBatches: 1,
      failedTestBatches: 1,
      nonzeroExitTestBatches: 0,
    });
  });
  it('recognizes failures in partial output, and leaves missing verdicts unknown', () => {
    expect(testOutcome('not ok 2 - restores balance\n')).toBe('failed');
    expect(testOutcome('ok 1 - one test\n')).toBe('unknown');
    expect(testOutcome('command not found')).toBe('unknown');
    expect(testOutcome('# tests 10\n# fail 0\n')).toBe('passed');
  });
});
