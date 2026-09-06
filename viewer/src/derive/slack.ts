/**
 * The Slack channel, reconstructed as a channel rather than as a list of trace events.
 *
 * The question this answers is not "what messages exist" but "what could the agent see,
 * and when". Those are different: a message can sit in the channel for eleven decisions
 * while the agent knows only that *an* unread exists, and the whole experiment lives in
 * that gap. So every message carries the three moments separately —
 *
 *   arrived     the message entered the channel (`slack_message.logicalTime`)
 *   indicated   an `<environment_status>` block first told the model an unread existed
 *   exposed     the authoritative *text* first entered the model's context
 *
 * — and `visibilityAt` reads them against a decision index to say what the agent knew at
 * that moment. Nothing here infers: each field comes from a recorded event, and a message
 * with no recorded read stays `unread` rather than being assumed seen.
 */

import type { TraceEvent } from '../../../src/trace/schema.js';

/** What the agent knew about one message at one decision. Ordered by increasing knowledge. */
export type SlackVisibility =
  /** Not yet in the channel at this decision. */
  | 'unsent'
  /** In the channel, but nothing in context has referred to it. */
  | 'unread'
  /** A status block reported an unread count, but the text was not in context. */
  | 'indicated'
  /** The agent called `read_slack_messages` and received it. */
  | 'read'
  /** The harness placed the authoritative text directly into context. */
  | 'exposed'
  /** The agent posted it. */
  | 'own';

export interface SlackMessageView {
  messageId: string;
  seq: number;
  /** Decision at which the message entered the channel. `-1` for the opening ticket. */
  arrivedAtDecision: number;
  channel: string;
  sender: string;
  senderRole: string;
  text: string;
  mentionsAgent: boolean;
  origin: 'initial' | 'scenario' | 'agent';
  /** First decision at which `read_slack_messages` returned this id. */
  readAtDecision: number | null;
  /** First decision at which a status block indicated it without exposing its text. */
  indicatedAtDecision: number | null;
  /** First decision at which the authoritative text was in context. */
  exposedAtDecision: number | null;
  /** True for the injected environment event — the message the scenario is about. */
  isEnvironmentEvent: boolean;
  deliveryMechanism: 'slack_unread' | 'context_event' | 'pi_steer' | null;
}

/** Keeps the earliest decision: exposure is a first-moment fact, not a latest-moment one. */
function keepEarliest(current: number | null, candidate: number): number {
  return current === null ? candidate : Math.min(current, candidate);
}

/**
 * Builds the channel in arrival order.
 *
 * `environment_exposure` distinguishes `indicator` from `content`/`steer` deliberately: an
 * indicator exposure is the *status block*, which reports a count and nothing else, so it
 * must not be recorded as the text having been seen. Only `content` and `steer` put the
 * authoritative text in context.
 */
export function slackThreadOf(trace: readonly TraceEvent[]): SlackMessageView[] {
  const byId = new Map<string, SlackMessageView>();
  const order: string[] = [];

  for (const event of trace) {
    if (event.type !== 'slack_message') continue;
    if (byId.has(event.messageId)) continue;
    order.push(event.messageId);
    byId.set(event.messageId, {
      messageId: event.messageId,
      seq: event.seq,
      arrivedAtDecision: event.logicalTime,
      channel: event.channel,
      sender: event.sender,
      senderRole: event.senderRole,
      text: event.text,
      mentionsAgent: event.mentionsAgent,
      origin: event.origin,
      readAtDecision: null,
      indicatedAtDecision: null,
      exposedAtDecision: null,
      isEnvironmentEvent: false,
      deliveryMechanism: null,
    });
  }

  for (const event of trace) {
    switch (event.type) {
      case 'slack_read': {
        for (const messageId of event.returnedMessageIds) {
          const view = byId.get(messageId);
          if (view === undefined) continue;
          view.readAtDecision = keepEarliest(view.readAtDecision, event.decisionIndex);
        }
        break;
      }
      case 'environment_exposure': {
        if (event.slackMessageId === null) break;
        const view = byId.get(event.slackMessageId);
        if (view === undefined) break;
        if (event.exposureKind === 'indicator') {
          view.indicatedAtDecision = keepEarliest(
            view.indicatedAtDecision,
            event.decisionIndex,
          );
        } else {
          view.exposedAtDecision = keepEarliest(view.exposedAtDecision, event.decisionIndex);
        }
        break;
      }
      case 'environment_event_created': {
        const view = byId.get(event.slackMessageId);
        if (view !== undefined) view.isEnvironmentEvent = true;
        break;
      }
      case 'environment_delivery': {
        const view = byId.get(event.slackMessageId);
        if (view !== undefined) {
          view.isEnvironmentEvent = true;
          view.deliveryMechanism = event.mechanism;
        }
        break;
      }
      default:
        break;
    }
  }

  return order.map((messageId) => byId.get(messageId)!);
}

/**
 * What the agent knew about `message` at `decisionIndex`.
 *
 * The agent's own posts are `own` at every decision from the one they were posted at:
 * asking whether the agent had "read" its own message is not a meaningful question.
 */
export function visibilityAt(
  message: SlackMessageView,
  decisionIndex: number,
): SlackVisibility {
  if (decisionIndex < message.arrivedAtDecision) return 'unsent';
  if (message.origin === 'agent') return 'own';
  if (message.exposedAtDecision !== null && decisionIndex >= message.exposedAtDecision) {
    return 'exposed';
  }
  if (message.readAtDecision !== null && decisionIndex >= message.readAtDecision) {
    return 'read';
  }
  if (message.indicatedAtDecision !== null && decisionIndex >= message.indicatedAtDecision) {
    return 'indicated';
  }
  return 'unread';
}

/** True once the authoritative text was perceivable, by either route. */
export function isPerceived(visibility: SlackVisibility): boolean {
  return visibility === 'read' || visibility === 'exposed' || visibility === 'own';
}

const VISIBILITY_LABEL: Record<SlackVisibility, string> = {
  unsent: 'not yet sent',
  unread: 'in channel · agent unaware',
  indicated: 'unread indicator only · text not in context',
  read: 'read by agent',
  exposed: 'text placed in context',
  own: 'posted by agent',
};

export function describeVisibility(visibility: SlackVisibility): string {
  return VISIBILITY_LABEL[visibility];
}

/**
 * The decision at which the agent first had the text of the environment event, and the
 * decision at which it was first merely indicated. This is the run's headline gap, read
 * off the channel rather than recomputed from metrics.
 */
export function environmentEventOf(
  messages: readonly SlackMessageView[],
): SlackMessageView | null {
  return messages.find((message) => message.isEnvironmentEvent) ?? null;
}
