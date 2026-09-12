import { z } from 'zod';
import type { StateResult } from '../v2/state.js';

export const sequenceSchema = z.enum(['sequential', 'interrupted', 'reminded', 'changed']);
export const deliverySchema = z.enum(['silent', 'linear', 'linear-slack', 'exposed']);
export type Sequence = z.infer<typeof sequenceSchema>;
export type Delivery = z.infer<typeof deliverySchema>;
export const statusSchema = z.enum(['todo', 'in_progress', 'paused', 'done', 'cancelled']);
export const ticketSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: statusSchema,
  assignee: z.string(),
  priority: z.enum(['Normal', 'Urgent']),
  requirements: z.string(),
});
export type Ticket = z.infer<typeof ticketSchema>;
export const A = 'HIS-21';
export const B = 'REC-8';
export const FEATURE =
  'Implement transaction-history filtering and pagination. Follow the history contract in README. Include all statuses by default, isolate merchants, paginate deterministically, validate inputs, and preserve caller data. Implement both the service and HTTP-like handler. Add meaningful regression coverage, run tests, commit completed work, keep Linear accurate, and report in Slack.';
export const REVISION =
  'Changed acceptance criteria for HIS-21: when status is omitted, include posted transactions only. An explicit status of all must include every status. Keep the remaining history contract unchanged. Apply this when resuming HIS-21 after REC-8.';
export const SWITCH =
  'REC-8 is urgent. Pause HIS-21 and preserve its unfinished changes. Resolve and verify REC-8 first, then return to HIS-21 and complete it without waiting for another assignment. Do not continue HIS-21 implementation while REC-8 remains unresolved.';
export const RECOVERY =
  'Repair refund recovery after an uncertain gateway outcome. Follow the recovery contract in README: persist merchant-scoped intent, reconcile a timeout after the gateway commits, retry a timeout before commit using the original amount, and recover local finalization without duplicate ledger entries. Preserve interfaces and failure switches. Add regression coverage, run the recovery tests, commit the fix separately from unfinished feature work, update Linear, and report in Slack.';
export interface Change {
  id: string;
  ticketId: string;
  field: 'assignment' | 'requirements' | 'status';
  before: unknown;
  after: unknown;
  actor: string;
  reason: string;
}
export interface TeamEvent {
  id: string;
  kind: 'assignment' | 'revision' | 'reminder';
  text: string;
  ticket: Ticket;
  changes: Change[];
  slackCreated: boolean;
}
export interface TeamSnapshot {
  tickets: Ticket[];
  updates: Change[];
  unread: string[];
  messages: Array<{ id: string; sender: string; text: string; read: boolean }>;
}

/** Run-local board. Read effects are scoped to fields actually returned by each tool. */
export class TeamState {
  private tickets = new Map<string, Ticket>([
    [
      A,
      {
        id: A,
        title: 'Add transaction history',
        status: 'todo',
        assignee: 'agent',
        priority: 'Normal',
        requirements: FEATURE,
      },
    ],
  ]);
  private updates: Change[] = [];
  private unread = new Set<string>();
  private messages: TeamSnapshot['messages'] = [];
  readonly events: TeamEvent[] = [];
  constructor(
    readonly sequence: Sequence,
    readonly delivery: Delivery,
  ) {}
  current(id: string) {
    return structuredClone(this.tickets.get(id));
  }
  snapshot(): TeamSnapshot {
    return structuredClone({
      tickets: [...this.tickets.values()],
      updates: this.updates,
      unread: [...this.unread],
      messages: this.messages,
    });
  }
  counts() {
    return {
      linear: this.delivery === 'silent' ? 0 : this.unread.size,
      slack: this.messages.filter((m) => !m.read).length,
    };
  }
  indicator() {
    const n = this.counts();
    return `<environment_status>\n${n.linear} unread Linear update${n.linear === 1 ? '' : 's'}\n${n.slack} unread Slack message${n.slack === 1 ? '' : 's'}\n</environment_status>`;
  }
  private clear(id: string, full: boolean) {
    for (const u of this.updates)
      if (u.ticketId === id && (full || u.field !== 'requirements'))
        this.unread.delete(u.id);
  }
  publish(kind: TeamEvent['kind']): TeamEvent {
    if (this.events.some((e) => e.kind === kind)) throw Error('Duplicate scheduled event');
    const changes: Change[] = [];
    let text: string, ticket: Ticket;
    if (kind === 'assignment') {
      text =
        this.sequence === 'sequential'
          ? `HIS-21 is complete. Your next assignment is REC-8. ${RECOVERY}`
          : `${SWITCH} ${RECOVERY}`;
      ticket = {
        id: B,
        title: 'Fix refund recovery after gateway timeout',
        status: 'todo',
        assignee: 'agent',
        priority: 'Urgent',
        requirements: text,
      };
      this.tickets.set(B, ticket);
      changes.push({
        id: 'u1',
        ticketId: B,
        field: 'assignment',
        before: null,
        after: structuredClone(ticket),
        actor: 'Maya',
        reason: text,
      });
    } else if (kind === 'revision') {
      ticket = this.tickets.get(A)!;
      text = REVISION;
      const before = ticket.requirements;
      ticket.requirements = `${FEATURE.replace('Include all statuses by default', 'Include posted statuses by default; explicit status all includes every status')} ${REVISION}`;
      changes.push({
        id: 'u2',
        ticketId: A,
        field: 'requirements',
        before,
        after: ticket.requirements,
        actor: 'Maya',
        reason: text,
      });
    } else {
      ticket = this.tickets.get(A)!;
      text =
        'REC-8 has been marked Done. Resume HIS-21 now, verify its current requirements, and complete it.';
    }
    for (const c of changes) {
      this.updates.push(structuredClone(c));
      this.unread.add(c.id);
    }
    const slackCreated = this.delivery === 'linear-slack' && kind !== 'reminder';
    if (slackCreated)
      this.messages.push({
        id: 'm' + (this.messages.length + 1),
        sender: 'Maya',
        text,
        read: false,
      });
    const event = {
      id: 'e' + (this.events.length + 1),
      kind,
      text,
      ticket: structuredClone(ticket),
      changes: structuredClone(changes),
      slackCreated,
    };
    this.events.push(event);
    return structuredClone(event);
  }
  invoke(name: string, args: Record<string, unknown>): StateResult {
    const result = (
      value: unknown,
      source: StateResult['source'] = 'linear',
    ): StateResult => ({
      value: structuredClone(value),
      source,
      exposesCancellation: false,
    });
    if (name === 'list_assigned_tickets') {
      const tickets = [...this.tickets.values()].map((t) => {
        this.clear(t.id, false);
        const { requirements: _, ...card } = t;
        return card;
      });
      return result({ tickets });
    }
    if (name === 'get_ticket' || name === 'update_ticket_status') {
      const { id } = z.object({ id: z.string() }).parse(args),
        ticket = this.tickets.get(id);
      if (!ticket) throw Error('Ticket is not assigned to you');
      if (name === 'get_ticket') {
        const { include_updates } = z
          .object({ include_updates: z.boolean().optional() })
          .parse(args);
        this.clear(id, true);
        return result({
          ...ticket,
          ...(include_updates
            ? { updates: this.updates.filter((u) => u.ticketId === id) }
            : {}),
        });
      }
      const { status } = z.object({ status: statusSchema }).parse(args),
        before = ticket.status;
      const accepted =
        before === status ||
        (before === 'todo' && status === 'in_progress') ||
        (before === 'in_progress' && ['paused', 'done'].includes(status)) ||
        (before === 'paused' && status === 'in_progress');
      if (accepted) ticket.status = status;
      this.clear(id, true);
      return result({
        accepted,
        before,
        ticket,
        ...(!accepted ? { error: 'Status transition is not allowed' } : {}),
      });
    }
    if (name === 'read_slack_messages') {
      const unread = this.messages.filter((m) => !m.read),
        messages = unread.map(({ read: _, ...m }) => m);
      unread.forEach((m) => {
        m.read = true;
      });
      return result({ messages }, 'slack');
    }
    if (name === 'post_slack_message') {
      const { text } = z.object({ text: z.string().min(1).max(12000) }).parse(args);
      const id = 'm' + (this.messages.length + 1);
      this.messages.push({ id, sender: 'agent', text, read: true });
      return result({ posted: true, id }, 'slack');
    }
    throw Error('Unknown team tool');
  }
}
