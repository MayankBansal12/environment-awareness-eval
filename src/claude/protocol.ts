/** Claude emits assistant content blocks before message_stop and may dispatch MCP early. */
export interface NativeBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: unknown;
}
export interface NativeTurn {
  blocks: NativeBlock[];
  stopReason: string;
}
export class NativeTurnAssembler {
  #blocks: NativeBlock[] = [];
  #stopReason = '';
  accept(event: {
    type: string;
    message?: { content: NativeBlock[] };
    event?: { type: string; delta?: { stop_reason?: string } };
  }): NativeTurn | undefined {
    if (event.type === 'assistant' && event.message)
      this.#blocks.push(...event.message.content);
    if (event.type === 'stream_event' && event.event?.type === 'message_delta')
      this.#stopReason = event.event.delta?.stop_reason ?? '';
    if (event.type !== 'stream_event' || event.event?.type !== 'message_stop')
      return undefined;
    const result = { blocks: this.#blocks, stopReason: this.#stopReason };
    this.#blocks = [];
    this.#stopReason = '';
    const calls = result.blocks.filter((b) => b.type === 'tool_use');
    if (
      calls.some(
        (c) =>
          !/^mcp__eval__(execute_batch|read|bash|edit|write|grep|find|ls|read_slack_messages|post_slack_message)$/.test(
            c.name ?? '',
          ),
      )
    )
      throw new Error('unsupported native tool call');
    return result;
  }
}
/** No action starts until message_stop; abort releases pending HTTP handlers. */
export class BatchBarrier {
  #ready = false;
  #waiters: Array<() => void> = [];
  publish(): void {
    this.#ready = true;
    for (const resolve of this.#waiters.splice(0)) resolve();
  }
  reset(): void {
    this.#ready = false;
  }
  async wait(signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error('run aborted');
    if (!this.#ready)
      await new Promise<void>((resolve) => {
        const done = () => {
          signal.removeEventListener('abort', done);
          resolve();
        };
        this.#waiters.push(done);
        signal.addEventListener('abort', done, { once: true });
      });
    if (signal.aborted) throw new Error('run aborted');
  }
}

/** Stable argument matching correlates HTTP RPCs with native tool-use IDs. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value) ?? 'null';
}
export class SiblingCollector<T> {
  readonly received = new Map<string, T>();
  constructor(readonly calls: Array<{ id: string; input: unknown }>) {}
  /**
   * Binds one HTTP tool-call request to its native tool_use block. `id` is the
   * authoritative `_meta["claudecode/toolUseId"]`; argument canonicalisation is only a
   * fallback for a runtime that does not send it. A redelivered id must be caught by the
   * caller before this point — reaching it for an already-claimed id is a protocol error.
   */
  add(input: unknown, value: T, id?: string): boolean {
    const call =
      (id !== undefined ? this.calls.find((c) => c.id === id) : undefined) ??
      this.calls.find(
        (c) => !this.received.has(c.id) && canonical(c.input) === canonical(input),
      );
    if (!call) throw new Error('MCP arguments do not match an unclaimed native tool call');
    if (this.received.has(call.id))
      throw new Error('MCP call redelivers an already-claimed native tool_use id');
    this.received.set(call.id, value);
    return this.received.size === this.calls.length;
  }
}
