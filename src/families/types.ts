import { z } from 'zod';

export const loadSchema = z.enum(['low', 'medium', 'high']);
export type Load = z.infer<typeof loadSchema>;

/** Which scheduled requirement updates actually reached the environment in this run. */
export interface SpecFlags {
  requirementChange: boolean;
  commentChange: boolean;
}
export const BASE_SPEC: SpecFlags = Object.freeze({
  requirementChange: false,
  commentChange: false,
});

export interface Check {
  id: string;
  passed: boolean;
  detail?: string;
}

export interface SlackLine {
  sender: string;
  channel: string;
  text: string;
}
export interface LinearNoise {
  /** `focal` targets the assigned ticket; otherwise a watched ticket not assigned to the agent. */
  ticket: 'focal' | string;
  actor: string;
  kind: 'label' | 'estimate' | 'cycle' | 'status' | 'comment' | 'link';
  summary: string;
  /** Comment body for kind=comment; harmless by construction. */
  body?: string;
}

/**
 * A task family is one repository, one focal ticket whose difficulty scales with load, one
 * urgent hotfix, and a fixed set of scheduled updates. The ticket text and update text are
 * identical across loads so that only the hidden difficulty of the focal work changes.
 */
export interface TaskFamily {
  id: string;
  version: string;
  focal: { id: string; title: string; requirements: string; paths: string[] };
  hotfix: {
    id: string;
    title: string;
    requirements: string;
    paths: string[];
    /** Incident tests whose inspection demonstrates engagement before a source edit. */
    testPaths?: string[];
  };
  /** Only the delayed-relevance arm replaces the secondary task with a later assignment. */
  delayed?: { context: SlackLine; staleReference: Record<string, string> };
  watched: Array<{ id: string; title: string; status: string; assignee: string }>;
  updates: {
    /** Replaces the focal ticket requirements. */
    requirementChange: { actor: string; requirements: string; reason: string };
    /** Ordinary-looking comment on the focal ticket that changes acceptance. */
    comment: { actor: string; text: string };
    /** Opinion without authority that, if adopted, violates the unchanged contract. */
    decoy: SlackLine;
    /** Slack ping that accompanies the urgent assignment. */
    urgentPing: SlackLine;
  };
  noise: { slack: SlackLine[]; linear: LinearNoise[] };
  bugs: Record<Load, string[]>;
  files(load: Load): Record<string, string>;
  /** Correct focal and hotfix sources for the given spec. */
  reference(spec: SpecFlags): Record<string, string>;
  referenceFocal(spec: SpecFlags): Record<string, string>;
  referenceHotfix(): Record<string, string>;
  /** Node module scripts; `__REPO__` is replaced by the repository root. Print JSON Check[]. */
  focalProbe(spec: SpecFlags): string;
  hotfixProbe(): string;
  checkIds: {
    focal: string[];
    requirementChange: string;
    comment: string;
    decoy: string;
    hotfix: string[];
  };
}

export const PROBE_HEADER = `import assert from 'node:assert/strict';const checks=[];const check=async(id,fn)=>{try{await fn();checks.push({id,passed:true});}catch(e){checks.push({id,passed:false,detail:String(e&&e.message||e).slice(0,300)});}};\n`;
