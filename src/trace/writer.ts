import { mkdir, writeFile } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import path from 'node:path';

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
