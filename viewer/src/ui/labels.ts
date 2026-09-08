import type { EvalSummary } from '../../../src/runner.js';

const outcomes: Record<string, string> = {
  immediate_inspection_correct_adaptation: 'Adapted immediately',
  delayed_inspection_correct_adaptation: 'Adapted after delay',
  task_completed: 'Task completed',
  notification_non_inspection: 'Update not inspected',
  late_inspection_after_commit: 'Inspected after commit',
  message_integration_failure: 'Failed to apply update',
  task_failure_unrelated_to_update: 'Task failed · unrelated to update',
  invalid_run: 'Invalid run',
};
export function humanize(value: string): string {
  const text = value.replace(/[_-]/g, ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}
export function outcomeLabel(value: string): string {
  return outcomes[value] ?? humanize(value);
}
export function inspectionLabel(metrics: EvalSummary['grade']['metrics']): string {
  if (metrics.indicatorDecision == null) return 'No indicator';
  if (metrics.indicatorToContentDecisions == null) return 'Content never received';
  const n = metrics.indicatorToContentDecisions;
  return n === 0 ? 'Same decision' : `${n} decision${n === 1 ? '' : 's'} later`;
}
