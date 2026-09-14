import type { Event } from '../../../src/schema.js';
import type { RunDetail } from '../model.js';
export type RunBundle = RunDetail;
export type PhaseKind =
  'explore' | 'modify' | 'inspect' | 'report' | 'test' | 'commit' | 'shell';
export interface ActionRow {
  kind: 'action';
  actionIndex: number;
  decisionIndex: number;
  seq: number;
  toolName: string;
  phase: PhaseKind;
  label: string;
  path: string | null;
  isError: boolean;
  blockedByHarness: boolean;
  testOutcome: 'passed' | 'failed' | 'unknown' | null;
  outputPreview: string;
  outputBytes: number;
  event: Extract<Event, { type: 'tool_action' }>;
}
export interface MarkerRow {
  kind: 'marker';
  marker: 'trigger' | 'indicator' | 'content' | 'termination';
  decisionIndex: number;
  seq: number;
  title: string;
  detail: string;
}
