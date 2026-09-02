/**
 * Deterministic single-channel Slack simulation.
 *
 * Read state is tracked per message. This matters because an agent can post while an
 * older inbound message is unread: a single high-water cursor would silently consume
 * that older message. The exposed cursor is only the highest contiguous read sequence.
 */
export type SlackSenderRole = 'ticket_owner' | 'teammate' | 'agent';

export interface SlackMessage {
  id: string;
  sequence: number;
  logicalTime: number;
  channel: string;
  sender: string;
  senderRole: SlackSenderRole;
  text: string;
  mentionsAgent: boolean;
}

export interface SlackMessageView {
  id: string;
  channel: string;
  sender: string;
  senderRole: SlackSenderRole;
  logicalTime: number;
  text: string;
  mentionsAgent: boolean;
}

export interface SlackCounts {
  unread: number;
  mentions: number;
}

export const DEFAULT_CHANNEL = 'engineering';

export class SlackState {
  readonly #channel: string;
  readonly #messages: SlackMessage[] = [];
  readonly #readSequences = new Set<number>();
  #nextSequence = 1;
  #readCursor = 0;

  constructor(channel: string = DEFAULT_CHANNEL) {
    this.#channel = channel;
  }

  get channel(): string {
    return this.#channel;
  }

  all(): readonly SlackMessage[] {
    return this.#messages;
  }

  get readCursor(): number {
    return this.#readCursor;
  }

  post(input: {
    sender: string;
    senderRole: SlackSenderRole;
    text: string;
    mentionsAgent: boolean;
    logicalTime: number;
    markReadImmediately?: boolean;
  }): SlackMessage {
    const sequence = this.#nextSequence++;
    const message: SlackMessage = {
      id: `m${sequence}`,
      sequence,
      logicalTime: input.logicalTime,
      channel: this.#channel,
      sender: input.sender,
      senderRole: input.senderRole,
      text: input.text,
      mentionsAgent: input.mentionsAgent,
    };
    this.#messages.push(message);
    if (input.markReadImmediately === true || input.senderRole === 'agent') {
      this.#readSequences.add(sequence);
      this.#advanceContiguousCursor();
    }
    return message;
  }

  peekUnread(): readonly SlackMessage[] {
    return this.#messages.filter(
      (message) =>
        message.senderRole !== 'agent' && !this.#readSequences.has(message.sequence),
    );
  }

  counts(): SlackCounts {
    const unread = this.peekUnread();
    return {
      unread: unread.length,
      mentions: unread.filter((message) => message.mentionsAgent).length,
    };
  }

  markMessageRead(id: string): boolean {
    const message = this.#messages.find((candidate) => candidate.id === id);
    if (message === undefined) return false;
    this.#readSequences.add(message.sequence);
    this.#advanceContiguousCursor();
    return true;
  }

  readUnread(): SlackMessageView[] {
    const unread = [...this.peekUnread()];
    for (const message of unread) this.#readSequences.add(message.sequence);
    this.#advanceContiguousCursor();
    return unread.map(toView);
  }

  #advanceContiguousCursor(): void {
    while (this.#readSequences.has(this.#readCursor + 1)) {
      this.#readCursor += 1;
    }
  }
}

export function toView(message: SlackMessage): SlackMessageView {
  return {
    id: message.id,
    channel: message.channel,
    sender: message.sender,
    senderRole: message.senderRole,
    logicalTime: message.logicalTime,
    text: message.text,
    mentionsAgent: message.mentionsAgent,
  };
}
