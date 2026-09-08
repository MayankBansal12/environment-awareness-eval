import { mkdir, writeFile } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import path from 'node:path';

import {
  MODEL_CALL_SCHEMA_VERSION,
  modelCallRecordSchema,
  type ModelCallRecordInput,
} from './model-call.js';
import { traceEventSchema, type TraceEvent } from './schema.js';

const SECRET_PATTERNS = [
  /\b(sk-[A-Za-z0-9_-]{12,})\b/g,
  /\b(Bearer\s+)[A-Za-z0-9._~+\/-]{12,}/gi,
  /\b(api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi,
];

export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce(
    (value, pattern) =>
      value.replace(pattern, (_match, prefix?: string) =>
        typeof prefix === 'string' && prefix.toLowerCase().startsWith('bearer')
          ? `${prefix}[REDACTED]`
          : '[REDACTED]',
      ),
    text,
  );
}

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

  private constructor(contextPath: string) {
    this.path = contextPath;
  }

  static async create(runDir: string): Promise<ModelCallWriter> {
    await mkdir(runDir, { recursive: true });
    const contextPath = path.join(runDir, 'context.jsonl');
    await writeFile(contextPath, '', 'utf8');
    return new ModelCallWriter(contextPath);
  }

  append(input: ModelCallRecordInput): void {
    const record = modelCallRecordSchema.parse({
      ...input,
      schemaVersion: MODEL_CALL_SCHEMA_VERSION,
    });
    this.#count += 1;
    appendFileSync(this.path, JSON.stringify(record) + '\n', 'utf8');
  }

  get count(): number {
    return this.#count;
  }
}
