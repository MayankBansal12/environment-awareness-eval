import { mkdir, writeFile } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import path from 'node:path';

import {
  MODEL_CALL_SCHEMA_VERSION,
  modelCallRecordSchema,
  type ModelCallRecordInput,
} from './model-call.js';
import { traceEventSchema, type TraceEvent } from './schema.js';

// Redaction lives in its own module so the engine can scrub captured context without
// importing `node:fs`. Re-exported here because every existing caller imports it from the
// writer, and the two artifacts must never diverge on what counts as a secret.
export { redactSecrets } from './redact.js';

export class TraceWriter {
  readonly path: string;
  readonly #events: TraceEvent[] = [];

  private constructor(tracePath: string) {
    this.path = tracePath;
  }

  static async create(runDir: string): Promise<TraceWriter> {
    await mkdir(runDir, { recursive: true });
    const tracePath = path.join(runDir, 'trace.jsonl');
    await writeFile(tracePath, '', 'utf8');
    return new TraceWriter(tracePath);
  }

  append(input: TraceEvent): void {
    const event = traceEventSchema.parse(input);
    this.#events.push(event);
    appendFileSync(this.path, JSON.stringify(event) + '\n', 'utf8');
  }

  events(): readonly TraceEvent[] {
    return this.#events;
  }
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

/**
 * Writes `context.jsonl` — the captured model context, beside the trace.
 *
 * Kept separate from `TraceWriter` because the two artifacts have different consumers and
 * very different volume: the grader reads every trace event, and nothing in the grading
 * path reads a captured context. Same append-on-write discipline, so a run killed midway
 * still leaves every call it completed.
 */
export class ModelCallWriter {
  readonly path: string;
  #count = 0;
  #headerWritten = false;
  readonly #inputDecisions: number[] = [];
  readonly #outputDecisions: number[] = [];

  private constructor(contextPath: string) {
    this.path = contextPath;
  }

  static async create(runDir: string): Promise<ModelCallWriter> {
    await mkdir(runDir, { recursive: true });
    const contextPath = path.join(runDir, 'context.jsonl');
    await writeFile(contextPath, '', 'utf8');
    return new ModelCallWriter(contextPath);
  }

  /**
   * Validates and appends one record. Throws on a record that does not match the schema,
   * so a malformed capture is reported by the caller's audit rather than written.
   */
  append(input: ModelCallRecordInput): void {
    const record = modelCallRecordSchema.parse({
      ...input,
      schemaVersion: MODEL_CALL_SCHEMA_VERSION,
    });
    appendFileSync(this.path, JSON.stringify(record) + '\n', 'utf8');
    // Counted after the write, so the stats describe the file rather than the intent.
    this.#count += 1;
    if (record.type === 'capture_header') this.#headerWritten = true;
    if (record.type === 'call_input') this.#inputDecisions.push(record.decisionIndex);
    if (record.type === 'call_output') this.#outputDecisions.push(record.decisionIndex);
  }

  get count(): number {
    return this.#count;
  }

  /** What actually reached `context.jsonl`, for the run-level `capture_audit` record. */
  stats(): {
    headerWritten: boolean;
    inputDecisions: readonly number[];
    outputDecisions: readonly number[];
    count: number;
  } {
    return {
      headerWritten: this.#headerWritten,
      inputDecisions: [...this.#inputDecisions],
      outputDecisions: [...this.#outputDecisions],
      count: this.#count,
    };
  }
}
