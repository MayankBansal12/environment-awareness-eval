import type { PhaseKind } from './model.js';
export const PHASE_GLYPH: Record<PhaseKind, string> = {
  explore: '◇',
  modify: '✎',
  inspect: '◉',
  report: '▤',
  test: '▶',
  commit: '◆',
  shell: '$',
};
