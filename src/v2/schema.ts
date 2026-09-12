import { z } from 'zod';
import { capturedMessageSchema } from '../trace/model-call.js';
import { conditionSchema, demandSchema, ticketSchema } from './state.js';

export const snapshotSchema = z.object({
  digest: z.string(),
  implementationDigest: z.string(),
  commits: z.array(z.string()),
  status: z.string(),
  changedPaths: z.array(z.string()),
});
export type Snapshot = z.infer<typeof snapshotSchema>;
const base = {
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  format: z.literal('environment-v2'),
  seq: z.number().int(),
  decision: z.number().int(),
  at: z.string(),
};
export const eventSchema = z.discriminatedUnion('type', [
  z.object({
    ...base,
    type: z.literal('run_start'),
    runId: z.string(),
    demand: demandSchema,
    condition: conditionSchema,
    fixtureCommit: z.string(),
    fixtureDigest: z.string(),
    runtime: z.record(z.string(), z.unknown()),
  }),
  z.object({
    ...base,
    type: z.literal('tool_action'),
    id: z.string(),
    name: z.string(),
    args: z.record(z.string(), z.unknown()),
    value: z.unknown(),
    isError: z.boolean(),
    statusAttempt: z.unknown().optional(),
  }),
  z.object({ ...base, type: z.literal('snapshot'), snapshot: snapshotSchema }),
  z.object({
    ...base,
    type: z.literal('checkpoint'),
    responseOpportunity: z.boolean(),
    eventCreated: z.boolean(),
    ticket: ticketSchema,
  }),
  z.object({
    ...base,
    type: z.literal('ticket_changed'),
    before: ticketSchema,
    after: ticketSchema,
    slackCreated: z.boolean(),
  }),
  z.object({
    ...base,
    type: z.literal('exposure'),
    kind: z.enum(['indicator', 'content']),
    source: z.enum(['linear', 'slack', 'exposed']),
    toolCallId: z.string().optional(),
  }),
  z.object({
    ...base,
    type: z.literal('decision_input'),
    status: z.string(),
    contentSources: z.array(z.string()),
    messageCount: z.number().int(),
  }),
  z.object({
    ...base,
    type: z.literal('decision_output'),
    text: z.string(),
    stopReason: z.string(),
    toolCallIds: z.array(z.string()),
    usage: z.record(z.string(), z.number()).optional(),
  }),
  z.object({
    ...base,
    type: z.literal('termination'),
    reason: z.enum([
      'agent_finished',
      'provider_error',
      'harness_error',
      'timeout',
      'max_turns',
      'max_actions',
      'max_output_tokens',
      'aborted',
    ]),
    detail: z.string(),
  }),
]);
export type V2Event = z.infer<typeof eventSchema>;
export type EventInput = V2Event extends infer E
  ? E extends V2Event
    ? Omit<E, keyof typeof base>
    : never
  : never;
export const contextSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('header'),
    systemPrompt: z.string(),
    tools: z.array(
      z.object({ name: z.string(), description: z.string(), parameters: z.unknown() }),
    ),
    runtime: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal('input'),
    decision: z.number().int(),
    messages: z.array(capturedMessageSchema),
  }),
  z.object({
    type: z.literal('output'),
    decision: z.number().int(),
    message: capturedMessageSchema,
  }),
  z.object({
    type: z.literal('audit'),
    inputs: z.number().int(),
    outputs: z.number().int(),
    complete: z.boolean(),
    partialContent: z.boolean(),
    note: z.string(),
  }),
]);
export type V2Context = z.infer<typeof contextSchema>;
export const checkSchema = z.object({
  id: z.string(),
  passed: z.boolean(),
  detail: z.string().optional(),
});
export const summarySchema = z.object({
  format: z.literal('environment-v2'),
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  runId: z.string(),
  demand: demandSchema,
  condition: conditionSchema,
  runtime: z.record(z.string(), z.unknown()),
  fixtureCommit: z.string(),
  fixtureDigest: z.string(),
  termination: z.object({ reason: z.string(), detail: z.string() }),
  grade: z.object({
    valid: z.boolean(),
    classification: z.string(),
    validity: z.array(checkSchema),
    outcomes: z.array(checkSchema),
    metrics: z.record(z.string(), z.unknown()),
  }),
  finalTicket: ticketSchema,
  finalWorkspace: snapshotSchema,
  hiddenChecks: z.array(checkSchema),
  visibleTests: z.object({ passed: z.boolean(), output: z.string() }),
  capture: z.object({
    complete: z.boolean(),
    partialContent: z.boolean(),
    inputs: z.number(),
    outputs: z.number(),
  }),
  audit: z.object({ eligible: z.boolean(), checks: z.array(checkSchema) }).optional(),
  checkpointChecks: z.array(checkSchema).nullable().optional(),
  experiment: z
    .object({ manifestHash: z.string(), phase: z.string(), trialId: z.string() })
    .optional(),
  artifacts: z.record(z.string(), z.string()),
  retainedWorkspace: z.string().nullable(),
});
export type V2Summary = z.infer<typeof summarySchema>;
export interface V2Bundle {
  summary: V2Summary;
  trace: V2Event[];
  context: V2Context[];
}
