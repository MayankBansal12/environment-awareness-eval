/** Reads the parts of a Pi `AssistantMessage` the harness acts on. */
export interface AssistantInfo {
  stopReason: string;
  errorMessage: string | undefined;
  calls: Array<{ id: string; name: string }>;
}

export function assistantInfo(message: unknown): AssistantInfo {
  const record = (typeof message === 'object' && message !== null ? message : {}) as {
    content?: unknown;
    stopReason?: unknown;
    errorMessage?: unknown;
  };
  const calls: AssistantInfo['calls'] = [];
  for (const block of Array.isArray(record.content) ? record.content : []) {
    const part = block as { type?: unknown; id?: unknown; name?: unknown } | null;
    if (
      part?.type === 'toolCall' &&
      typeof part.id === 'string' &&
      typeof part.name === 'string'
    )
      calls.push({ id: part.id, name: part.name });
  }
  return {
    stopReason: typeof record.stopReason === 'string' ? record.stopReason : 'unknown',
    errorMessage: typeof record.errorMessage === 'string' ? record.errorMessage : undefined,
    calls,
  };
}
