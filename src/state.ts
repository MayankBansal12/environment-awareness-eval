import { z } from 'zod';
import type { TaskFamily } from './families/types.js';
import type { Delivery, ImportantKind, NoiseItem } from './scenario.js';

export const statusSchema = z.enum(['todo', 'in_progress', 'paused', 'in_review', 'done']);
export type Status = z.infer<typeof statusSchema>;
export const ME = 'you';

export interface Comment {
  id: string;
  author: string;
  body: string;
}
export interface Ticket {
  id: string;
  title: string;
  status: string;
  priority: 'Urgent' | 'High' | 'Medium' | 'Low';
  assignee: string;
  labels: string[];
  estimate: number | null;
  cycle: number | null;
  requirements: string;
  comments: Comment[];
}
export interface Notification {
  id: string;
  ticketId: string;
  actor: string;
  action: string;
  preview?: string;
  read: boolean;
  eventId: string;
}
export interface SlackMessage {
  id: string;
  channel: string;
  sender: string;
  text: string;
  read: boolean;
  eventId: string | null;
}
export interface TeamEvent {
  id: string;
  kind: ImportantKind | 'noise';
  important: boolean;
  /** Full text as it would be exposed inline. */
  text: string;
  notificationIds: string[];
  messageIds: string[];
}
export interface TeamSnapshot {
  tickets: Ticket[];
  notifications: Notification[];
  messages: SlackMessage[];
  events: TeamEvent[];
}
export interface StateResult {
  value: unknown;
  source: 'linear' | 'slack';
  /** Event ids whose summary/cue was returned. */
  cues: string[];
  /** Event ids whose authoritative content was returned. */
  contents: string[];
}

const PREVIEW = 60;
const card = (t: Ticket) => ({
  id: t.id,
  title: t.title,
  status: t.status,
  priority: t.priority,
  assignee: t.assignee,
  labels: [...t.labels],
});

/** Run-local simulated Linear and Slack. Returned values never share mutable references. */
export class TeamState {
  private tickets = new Map<string, Ticket>();
  private notifications: Notification[] = [];
  private messages: SlackMessage[] = [];
  readonly events: TeamEvent[] = [];
  constructor(
    readonly family: TaskFamily,
    readonly delivery: Delivery,
  ) {
    const f = family.focal;
    this.tickets.set(f.id, {
      id: f.id,
      title: f.title,
      status: 'todo',
      priority: 'High',
      assignee: ME,
      labels: [],
      estimate: 3,
      cycle: null,
      requirements: f.requirements,
      comments: [],
    });
    for (const w of family.watched)
      this.tickets.set(w.id, {
        id: w.id,
        title: w.title,
        status: w.status,
        priority: 'Medium',
        assignee: w.assignee,
        labels: [],
        estimate: null,
        cycle: null,
        requirements: `${w.title}. Owned by ${w.assignee}.`,
        comments: [],
      });
  }

  current(id: string): Ticket | undefined {
    return structuredClone(this.tickets.get(id));
  }
  snapshot(): TeamSnapshot {
    return structuredClone({
      tickets: [...this.tickets.values()],
      notifications: this.notifications,
      messages: this.messages,
      events: this.events,
    });
  }
  counts() {
    return {
      linear: this.notifications.filter((n) => !n.read).length,
      slack: this.messages.filter((m) => !m.read).length,
    };
  }
  indicator() {
    const n = this.counts();
    return `<environment_status>\nLinear inbox: ${n.linear} unread\nSlack: ${n.slack} unread\n</environment_status>`;
  }

  private event(kind: TeamEvent['kind'], text: string): TeamEvent {
    const event: TeamEvent = {
      id: 'e' + (this.events.length + 1),
      kind,
      important: kind !== 'noise',
      text,
      notificationIds: [],
      messageIds: [],
    };
    this.events.push(event);
    return event;
  }
  private notify(event: TeamEvent, n: Omit<Notification, 'id' | 'read' | 'eventId'>) {
    const id = 'n' + (this.notifications.length + 1);
    this.notifications.push({ ...n, id, read: false, eventId: event.id });
    event.notificationIds.push(id);
  }
  private post(event: TeamEvent | null, channel: string, sender: string, text: string) {
    const id = 'm' + (this.messages.length + 1);
    this.messages.push({
      id,
      channel,
      sender,
      text,
      read: false,
      eventId: event?.id ?? null,
    });
    event?.messageIds.push(id);
  }
  private addComment(ticket: Ticket, author: string, body: string) {
    const comment = { id: 'c' + (ticket.comments.length + 1), author, body };
    ticket.comments.push(comment);
    return comment;
  }

  publishImportant(kind: ImportantKind): TeamEvent {
    if (this.events.some((e) => e.kind === kind)) throw Error('Duplicate scheduled event');
    const f = this.family,
      focal = this.tickets.get(f.focal.id)!;
    if (kind === 'requirement_change') {
      const u = f.updates.requirementChange;
      focal.requirements = u.requirements;
      const event = this.event(
        kind,
        `${u.actor} updated the description of ${focal.id}:\n${u.requirements}`,
      );
      this.notify(event, {
        ticketId: focal.id,
        actor: u.actor,
        action: 'updated the description',
      });
      return structuredClone(event);
    }
    if (kind === 'urgent_assignment') {
      const h = f.hotfix,
        ping = f.updates.urgentPing;
      this.tickets.set(h.id, {
        id: h.id,
        title: h.title,
        status: 'todo',
        priority: 'Urgent',
        assignee: ME,
        labels: ['incident'],
        estimate: null,
        cycle: null,
        requirements: h.requirements,
        comments: [],
      });
      const event = this.event(
        kind,
        `${ping.sender} assigned ${h.id} to you (Urgent): ${h.title}\n${h.requirements}\n\n${ping.channel} ${ping.sender}: ${ping.text}`,
      );
      this.notify(event, {
        ticketId: h.id,
        actor: ping.sender,
        action: `assigned ${h.id} to you · priority Urgent · ${h.title}`,
      });
      this.post(event, ping.channel, ping.sender, ping.text);
      return structuredClone(event);
    }
    if (kind === 'comment_change') {
      const c = f.updates.comment;
      this.addComment(focal, c.actor, c.text);
      const event = this.event(kind, `${c.actor} commented on ${focal.id}:\n${c.text}`);
      this.notify(event, {
        ticketId: focal.id,
        actor: c.actor,
        action: 'commented',
        preview: c.text.slice(0, PREVIEW) + (c.text.length > PREVIEW ? '…' : ''),
      });
      return structuredClone(event);
    }
    const d = f.updates.decoy;
    const event = this.event(kind, `${d.channel} ${d.sender}: ${d.text}`);
    this.post(event, d.channel, d.sender, d.text);
    return structuredClone(event);
  }

  publishNoise(item: NoiseItem): TeamEvent {
    if (item.channel === 'slack') {
      const { channel, sender, text } = item.line;
      const event = this.event('noise', `${channel} ${sender}: ${text}`);
      this.post(event, channel, sender, text);
      return structuredClone(event);
    }
    const u = item.update,
      ticket = this.tickets.get(u.ticket === 'focal' ? this.family.focal.id : u.ticket);
    if (!ticket) throw Error('Unknown noise ticket');
    if (u.kind === 'label')
      ticket.labels.push(u.summary.replace(/^added label "(.*)"$/, '$1'));
    if (u.kind === 'estimate') ticket.estimate = Number(u.summary.split('→ ').at(-1));
    if (u.kind === 'cycle') ticket.cycle = Number(u.summary.split(' ').at(-1));
    if (u.kind === 'status')
      ticket.status = u.summary
        .replace(/^moved to /, '')
        .toLowerCase()
        .replace(' ', '_');
    if (u.kind === 'comment' && u.body) this.addComment(ticket, u.actor, u.body);
    const event = this.event(
      'noise',
      `${u.actor} ${u.summary} on ${ticket.id}${u.body ? `:\n${u.body}` : ''}`,
    );
    this.notify(event, {
      ticketId: ticket.id,
      actor: u.actor,
      action: u.summary,
      ...(u.body
        ? { preview: u.body.slice(0, PREVIEW) + (u.body.length > PREVIEW ? '…' : '') }
        : {}),
    });
    return structuredClone(event);
  }

  /** Exposed delivery: mark an event's notifications/messages read as its content is inlined. */
  markDelivered(eventId: string) {
    for (const n of this.notifications) if (n.eventId === eventId) n.read = true;
    for (const m of this.messages) if (m.eventId === eventId) m.read = true;
  }

  private contentEvents(ticketId: string): string[] {
    const ids = new Set<string>();
    for (const e of this.events) {
      if (e.kind === 'requirement_change' || e.kind === 'comment_change')
        if (ticketId === this.family.focal.id) ids.add(e.id);
      if (e.kind === 'urgent_assignment' && ticketId === this.family.hotfix.id)
        ids.add(e.id);
    }
    return [...ids];
  }

  invoke(name: string, args: Record<string, unknown>): StateResult {
    const result = (
      value: unknown,
      source: 'linear' | 'slack',
      cues: string[] = [],
      contents: string[] = [],
    ): StateResult => ({
      value: structuredClone(value),
      source,
      cues: [...new Set(cues)],
      contents: [...new Set(contents)],
    });
    if (name === 'linear_list_my_issues') {
      const mine = [...this.tickets.values()].filter((t) => t.assignee === ME);
      const cues: string[] = [];
      for (const n of this.notifications)
        if (
          mine.some((t) => t.id === n.ticketId) &&
          !n.read &&
          /^(assigned|moved|added label|changed estimate|moved to cycle|linked)/.test(
            n.action,
          )
        ) {
          n.read = true;
          cues.push(n.eventId);
        }
      // Seeing an urgent card is a cue for the assignment even without the inbox entry.
      for (const e of this.events)
        if (
          e.kind === 'urgent_assignment' &&
          mine.some((t) => t.id === this.family.hotfix.id)
        )
          cues.push(e.id);
      return result({ issues: mine.map(card) }, 'linear', cues);
    }
    if (name === 'linear_get_issue') {
      const { id } = z.object({ id: z.string() }).parse(args);
      const ticket = this.tickets.get(id.trim().toUpperCase());
      if (!ticket) throw Error(`Issue ${id} not found`);
      const cues: string[] = [];
      for (const n of this.notifications)
        if (n.ticketId === ticket.id && !n.read) {
          n.read = true;
          cues.push(n.eventId);
        }
      const { comments, ...rest } = ticket;
      return result({ ...rest, comments }, 'linear', cues, this.contentEvents(ticket.id));
    }
    if (name === 'linear_inbox') {
      const unread = this.notifications.filter((n) => !n.read);
      unread.forEach((n) => (n.read = true));
      return result(
        {
          notifications: unread.map((n) => ({
            id: n.id,
            issue: n.ticketId,
            actor: n.actor,
            action: n.action,
            ...(n.preview ? { preview: n.preview } : {}),
          })),
        },
        'linear',
        unread.map((n) => n.eventId),
      );
    }
    if (name === 'linear_update_issue_status') {
      const { id, status } = z.object({ id: z.string(), status: statusSchema }).parse(args);
      const ticket = this.tickets.get(id.trim().toUpperCase());
      if (!ticket) throw Error(`Issue ${id} not found`);
      if (ticket.assignee !== ME)
        throw Error(`${ticket.id} is assigned to ${ticket.assignee}`);
      const before = ticket.status;
      ticket.status = status;
      return result({ before, issue: card(ticket) }, 'linear');
    }
    if (name === 'linear_comment') {
      const { id, body } = z
        .object({ id: z.string(), body: z.string().min(1).max(12000) })
        .parse(args);
      const ticket = this.tickets.get(id.trim().toUpperCase());
      if (!ticket) throw Error(`Issue ${id} not found`);
      const comment = this.addComment(ticket, ME, body);
      return result({ posted: true, comment }, 'linear');
    }
    if (name === 'slack_read') {
      const unread = this.messages.filter((m) => !m.read);
      unread.forEach((m) => (m.read = true));
      const contents: string[] = [],
        cues: string[] = [];
      for (const m of unread) {
        if (!m.eventId) continue;
        const kind = this.events.find((e) => e.id === m.eventId)?.kind;
        if (kind === 'decoy' || kind === 'noise') contents.push(m.eventId);
        else cues.push(m.eventId);
      }
      return result(
        {
          messages: unread.map((m) => ({
            channel: m.channel,
            sender: m.sender,
            text: m.text,
          })),
        },
        'slack',
        cues,
        contents,
      );
    }
    if (name === 'slack_post') {
      const { channel, text } = z
        .object({ channel: z.string().min(1).max(80), text: z.string().min(1).max(12000) })
        .parse(args);
      const id = 'm' + (this.messages.length + 1);
      this.messages.push({ id, channel, sender: ME, text, read: true, eventId: null });
      return result({ posted: true, id }, 'slack');
    }
    throw Error('Unknown team tool');
  }
}
