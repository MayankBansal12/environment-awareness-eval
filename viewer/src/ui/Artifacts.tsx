/**
 * The non-timeline artifacts: the worktree diff, report.md, the hidden checks, and the
 * validity / outcome gate lists straight out of summary.json.
 */

import type { RunBundle } from '../derive/model.js';
import { stripWorkspacePrefixEverywhere } from '../derive/paths.js';

export function DiffView({ run }: { run: RunBundle }): JSX.Element {
  if (run.diff.trim() === '') {
    return <pre className="block empty">workspace.diff is empty — the agent left no changes.</pre>;
  }
  const lines = stripWorkspacePrefixEverywhere(run.diff, run.workspacePath).split('\n');
  return (
    <pre className="diff">
      {lines.map((line, index) => (
        <span className={`l ${diffClass(line)}`} key={index}>
          {line === '' ? ' ' : line}
        </span>
      ))}
    </pre>
  );
}

function diffClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta-line';
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  if (
    line.startsWith('diff ') ||
    line.startsWith('index ') ||
    line.startsWith('new file') ||
    line.startsWith('deleted file')
  ) {
    return 'meta-line';
  }
  return '';
}

export function ReportView({ run }: { run: RunBundle }): JSX.Element {
  return (
    <pre className="block">
      {run.reportMd.trim() === '' ? 'report.md is empty.' : run.reportMd}
    </pre>
  );
}

interface Check {
  id: string;
  passed?: boolean;
  status?: string;
  detail: string;
}

export function GatesView({ run }: { run: RunBundle }): JSX.Element {
  const grade = run.summary.grade;
  return (
    <>
      <h3>validity gates {grade.valid ? '· VALID' : '· INVALID'}</h3>
      <CheckList checks={grade.validity as unknown as Check[]} run={run} />
      <h3>outcome gates</h3>
      <CheckList checks={grade.outcome as unknown as Check[]} run={run} />
      <h3>hidden checks</h3>
      {run.summary.hiddenChecks.length === 0 ? (
        <pre className="block empty">No hidden checks ran for this scenario.</pre>
      ) : (
        <CheckList checks={run.summary.hiddenChecks as unknown as Check[]} run={run} />
      )}
      <h3>visible test suite</h3>
      <VisibleTests run={run} />
    </>
  );
}

/** `visibleTests` is absent for scenarios where a suite run is not required. */
function VisibleTests({ run }: { run: RunBundle }): JSX.Element {
  const tests = run.summary.visibleTests as
    | { status: string; command: string; exitCode: number; detail: string }
    | null
    | undefined;
  if (tests === null || tests === undefined) {
    return <pre className="block empty">No visible test suite was recorded for this run.</pre>;
  }
  return (
    <>
      <div className="check">
        <span className={`mark ${tests.status === 'passed' ? 'pass' : 'fail'}`}>
          {tests.status === 'passed' ? '✓' : '✗'}
        </span>
        <span className="id">{tests.command}</span>
        <span className="detail">
          {tests.status} · exit {tests.exitCode}
        </span>
      </div>
      <pre className="block">
        {stripWorkspacePrefixEverywhere(tests.detail, run.workspacePath)}
      </pre>
    </>
  );
}

function CheckList({ checks, run }: { checks: Check[]; run: RunBundle }): JSX.Element {
  return (
    <div>
      {checks.map((check) => {
        const passed = check.passed ?? check.status === 'passed';
        return (
          <div className="check" key={check.id}>
            <span className={`mark ${passed ? 'pass' : 'fail'}`}>{passed ? '✓' : '✗'}</span>
            <span className="id">{check.id}</span>
            <span className="detail">
              {stripWorkspacePrefixEverywhere(check.detail, run.workspacePath)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * The final assistant turn is the only model prose in the whole trace, and
 * `manualSignals.finalReportAcknowledgesUpdate` is graded on it — so it is shown in full,
 * never truncated.
 */
export function FinalReportView({ run }: { run: RunBundle }): JSX.Element {
  const termination = run.trace.find((event) => event.type === 'termination');
  const text =
    termination !== undefined && termination.type === 'termination'
      ? termination.finalAssistantText
      : '';
  const signal = run.summary.grade.manualSignals.finalReportAcknowledgesUpdate;
  return (
    <>
      <div className="facts">
        finalReportAcknowledgesUpdate:{' '}
        <b>{signal === null || signal === undefined ? '—' : signal ? 'true' : 'false'}</b>{' '}
        — graded on exactly this text.
      </div>
      <pre className="block">
        {text.trim() === ''
          ? 'The run recorded no final assistant text.'
          : stripWorkspacePrefixEverywhere(text, run.workspacePath)}
      </pre>
    </>
  );
}
