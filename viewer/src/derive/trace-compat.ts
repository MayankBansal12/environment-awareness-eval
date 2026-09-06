/**
 * Trace schema version compatibility.
 *
 * `traceEventSchema` pins `schemaVersion` with `z.literal(TRACE_SCHEMA_VERSION)`, so the
 * schema imported from `src/` accepts exactly one generation and rejects every other
 * outright — the current v3 schema rejects a v2 trace with `Invalid input: expected 3`,
 * and a v1 trace likewise.
 *
 * The corpus spans several: the two oldest reference runs are v1, the bulk are v2, v3
 * landed with the ticket-delivery work and v4 with reasoning capture. A mixed-generation
 * corpus is the normal case, not drift, so the viewer normalizes each event onto whatever
 * version the local schema declares before validating, and records the version the event
 * actually came from. It deliberately does not fork or restate the schema: the structural
 * rules still come from `src/`, and only the version literal and the fields newer versions
 * added are reconciled here.
 *
 * v3 adds a required `ticketDelivery` to `run_start`. Per the brief a legacy trace without
 * it describes a run whose ticket arrived over Slack, so that default is injected when
 * normalizing up, and the real value is captured before validating so it survives when
 * normalizing down (an older schema would silently strip the unknown key). Likewise v2
 * added the required `authoritativeContentMessageIds` list to `decision_boundary`, which
 * v1 traces predate — that defaults to empty (no record, not proven absence).
 *
 * v4 adds `reasoningText` / `reasoningRedacted` / `reasoningTokens` to `assistant_turn`,
 * all optional, so nothing is injected in either direction. The version still moved,
 * because the fields being *absent* means different things either side of it: before v4
 * the harness did not capture reasoning at all, after v4 an absent field means the
 * provider returned none. The UI relies on that distinction, so it must stay recoverable
 * from the trace's own version rather than inferred from an empty string.
 *
 * Normalizing *down* stays supported deliberately: the viewer is read-only over an
 * artifact tree that outlives any one schema bump, so it must open a corpus written by a
 * newer runner than the `src/` it was built against.
 */

export const SUPPORTED_TRACE_SCHEMA_VERSIONS = [1, 2, 3, 4] as const;

export type SupportedTraceSchemaVersion =
  (typeof SUPPORTED_TRACE_SCHEMA_VERSIONS)[number];

export type TicketDelivery = 'slack' | 'direct';

/** A trace or summary that predates the field describes a Slack-delivered ticket. */
export const DEFAULT_TICKET_DELIVERY: TicketDelivery = 'slack';

export function coerceTicketDelivery(value: unknown): TicketDelivery {
  return value === 'direct' || value === 'slack' ? value : DEFAULT_TICKET_DELIVERY;
}

export function isSupportedVersion(value: unknown): value is SupportedTraceSchemaVersion {
  return (
    typeof value === 'number' &&
    (SUPPORTED_TRACE_SCHEMA_VERSIONS as readonly number[]).includes(value)
  );
}

export interface NormalizedEvent {
  /** The event rewritten onto the local schema version, ready to validate. */
  candidate: Record<string, unknown>;
  /** The version the event was written at, before normalization. */
  sourceVersion: SupportedTraceSchemaVersion;
  /** Present only on `run_start`; captured before validation so v1/v2 cannot strip it. */
  ticketDelivery: TicketDelivery | null;
}

export type NormalizeResult =
  | { ok: true; value: NormalizedEvent }
  | { ok: false; reason: string };

/**
 * Rewrites one raw trace event onto `localVersion`, filling in fields a newer schema
 * requires. Returns a reason rather than throwing so the caller can attribute the failure
 * to a run and a line number.
 */
export function normalizeTraceEvent(raw: unknown, localVersion: number): NormalizeResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: 'event is not a JSON object' };
  }

  const event = raw as Record<string, unknown>;
  const sourceVersion = event['schemaVersion'];

  if (!isSupportedVersion(sourceVersion)) {
    return {
      ok: false,
      reason:
        `schemaVersion ${JSON.stringify(sourceVersion)} is not supported. The viewer ` +
        `reads v${SUPPORTED_TRACE_SCHEMA_VERSIONS.join(', v')}; extend ` +
        `SUPPORTED_TRACE_SCHEMA_VERSIONS in viewer/src/derive/trace-compat.ts once the ` +
        `new version's shape is understood, adding any newly required field to ` +
        `normalizeTraceEvent so legacy traces keep loading.`,
    };
  }

  const candidate: Record<string, unknown> = {
    ...event,
    schemaVersion: localVersion,
  };

  let ticketDelivery: TicketDelivery | null = null;
  if (event['type'] === 'run_start') {
    ticketDelivery = coerceTicketDelivery(event['ticketDelivery']);
    // Injected unconditionally: harmless under a v1/v2 schema, which strips unknown keys,
    // and required under v3, which would otherwise reject every legacy trace.
    candidate['ticketDelivery'] = ticketDelivery;
  }

  if (event['type'] === 'decision_boundary') {
    // v2 added the required `authoritativeContentMessageIds` list; v1 traces predate it.
    // Default to empty — the run header already surfaces the trace version, so a reader
    // can tell this is a legacy run with no record rather than a run with proven absence.
    if (candidate['authoritativeContentMessageIds'] === undefined) {
      candidate['authoritativeContentMessageIds'] = [];
    }
  }

  return { ok: true, value: { candidate, sourceVersion, ticketDelivery } };
}

/**
 * The version to report for a whole run. A trace is written by one runner in one pass, so
 * a run with mixed versions is corruption worth surfacing rather than averaging.
 */
export function runTraceVersion(
  versions: readonly SupportedTraceSchemaVersion[],
): { version: SupportedTraceSchemaVersion | null; mixed: boolean } {
  const distinct = [...new Set(versions)];
  const first = distinct[0];
  if (first === undefined) return { version: null, mixed: false };
  return { version: first, mixed: distinct.length > 1 };
}
