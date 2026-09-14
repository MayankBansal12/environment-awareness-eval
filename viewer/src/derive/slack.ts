import type { RunBundle } from './model.js';
import type { StateResult } from '../../../src/state.js';
import { KIND_LABEL } from '../derive.js';
export type SlackVisibility =
  'unsent' | 'unread' | 'indicated' | 'read' | 'exposed' | 'own';
export interface SlackMessageView {
  messageId: string;
  eventId: string | null;
  channel: string;
  sender: string;
  senderRole: string;
  source: 'linear' | 'slack';
  cueOnly: boolean;
  text: string;
  mentionsAgent: boolean;
  isEnvironmentEvent: boolean;
  arrivedAtDecision: number;
  indicatedAtDecision: number | null;
  readAtDecision: number | null;
  exposedAtDecision: number | null;
  deliveryMechanism: string | null;
}
export function slackThreadOf(run: RunBundle): SlackMessageView[] {
  const messages: SlackMessageView[] = [];
  for (const e of run.trace) {
    if (e.type !== 'environment_event') continue;
    const event = e.event;
    const exposures = run.trace.filter(
      (x) => x.type === 'exposure' && x.eventId === event.id,
    );
    const reads = run.trace.filter(
      (x) =>
        x.type === 'tool_action' &&
        !x.observation.isError &&
        (x.observation.effect as StateResult | undefined)?.contents?.includes(event.id),
    );
    const cues = run.trace.filter(
      (x) =>
        x.type === 'tool_action' &&
        !x.observation.isError &&
        (x.observation.effect as StateResult | undefined)?.cues?.includes(event.id),
    );
    const content = exposures.find((x) => x.type === 'exposure' && x.level === 'content');
    const cue = exposures.find((x) => x.type === 'exposure' && x.level === 'cue');
    // Reading the urgent Slack ping retrieves the ping, but only cues the assignment.
    // Its authoritative requirements live in Linear and have a separate content metric.
    const slackRead = [...reads, ...cues]
      .filter((x) => x.type === 'tool_action' && x.observation.name === 'slack_read')
      .sort((a, b) => a.seq - b.seq)[0];
    const inlineDecision =
      run.summary.condition.delivery === 'exposed'
        ? (run.trace.find((x) => x.type === 'input' && x.seq > e.seq)?.decision ?? null)
        : null;
    const exposed = content?.type === 'exposure' && content.via === 'exposed';
    const common = {
      eventId: event.id,
      isEnvironmentEvent: event.important,
      arrivedAtDecision: e.decision,
      indicatedAtDecision: cue?.decision ?? cues[0]?.decision ?? null,
      readAtDecision: exposed ? null : (content?.decision ?? reads[0]?.decision ?? null),
      exposedAtDecision: exposed ? content.decision : inlineDecision,
      senderRole: event.kind === 'noise' ? 'noise' : KIND_LABEL[event.kind],
      mentionsAgent: event.kind === 'urgent_assignment',
      deliveryMechanism: event.kind === 'noise' ? 'noise' : run.summary.condition.delivery,
    };
    for (const id of event.messageIds) {
      const m = run.summary.team.messages.find((m) => m.id === id);
      if (m)
        messages.push({
          ...common,
          messageId: id,
          source: 'slack',
          cueOnly: event.kind === 'urgent_assignment',
          readAtDecision: slackRead?.decision ?? null,
          channel: `#${m.channel}`,
          sender: m.sender,
          text: m.text,
        });
    }
    for (const id of event.notificationIds) {
      const n = run.summary.team.notifications.find((n) => n.id === id);
      if (n)
        messages.push({
          ...common,
          messageId: id,
          source: 'linear',
          cueOnly: false,
          channel: `Linear · ${n.ticketId}`,
          sender: n.actor,
          text: event.text,
        });
    }
  }
  for (const m of run.summary.team.messages.filter((m) => m.eventId === null)) {
    const action = run.trace.find(
      (e) =>
        e.type === 'tool_action' &&
        e.observation.name === 'slack_post' &&
        (e.observation.value as { id?: string } | null)?.id === m.id,
    );
    // Final team state alone cannot locate a message in history.
    if (!action) continue;
    messages.push({
      messageId: m.id,
      source: 'slack',
      cueOnly: false,
      eventId: null,
      channel: `#${m.channel}`,
      sender: m.sender,
      senderRole: 'agent',
      text: m.text,
      isEnvironmentEvent: false,
      mentionsAgent: false,
      arrivedAtDecision: action.decision,
      indicatedAtDecision: null,
      readAtDecision: null,
      exposedAtDecision: null,
      deliveryMechanism: null,
    });
  }
  return messages.sort((a, b) => a.arrivedAtDecision - b.arrivedAtDecision);
}
export function visibilityAt(message: SlackMessageView, cursor: number): SlackVisibility {
  if (message.arrivedAtDecision > cursor) return 'unsent';
  if (message.senderRole === 'agent') return 'own';
  if (message.exposedAtDecision !== null && message.exposedAtDecision <= cursor)
    return 'exposed';
  if (message.readAtDecision !== null && message.readAtDecision <= cursor) return 'read';
  if (message.indicatedAtDecision !== null && message.indicatedAtDecision <= cursor)
    return 'indicated';
  return 'unread';
}
export const describeVisibility = (state: SlackVisibility) =>
  ({
    unsent: 'not yet sent',
    unread: 'unread',
    indicated: 'cue seen · content unread',
    read: 'content read',
    exposed: 'content exposed inline',
    own: 'agent message',
  })[state];

/** The unread indicator first reaches an input after the event fires, before any cue is retrieved. */
export function indicatorDecision(run: RunBundle, eventId: string | null): number | null {
  const fired = run.trace.find(
    (e) => e.type === 'environment_event' && e.event.id === eventId,
  );
  return fired
    ? (run.trace.find((e) => e.type === 'input' && e.seq > fired.seq)?.decision ?? null)
    : null;
}
