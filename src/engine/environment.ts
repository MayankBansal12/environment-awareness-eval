/**
 * Pure, idempotent model-context annotation for deterministic environment observations.
 */
import type { SlackCounts, SlackMessageView } from './slack.js';

export type DeliveryMode = 'ambient' | 'exposed' | 'steer';

export interface AnnotatableMessage {
  role: string;
  content: string | Array<{ type: string; [key: string]: unknown }>;
  toolCallId?: string;
}

export type AnchorKey = string;
export const NO_ANCHOR: AnchorKey = 'none';

export function anchorKeyFor(messages: readonly AnnotatableMessage[]): AnchorKey {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'toolResult' && typeof message.toolCallId === 'string') {
      return `tool:${message.toolCallId}`;
    }
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') return `user:${index}`;
  }
  return NO_ANCHOR;
}

function matches(message: AnnotatableMessage, index: number, key: AnchorKey): boolean {
  if (key.startsWith('tool:')) {
    return message.role === 'toolResult' && `tool:${message.toolCallId}` === key;
  }
  return key.startsWith('user:') && message.role === 'user' && `user:${index}` === key;
}

const STATUS_BLOCK = /\n*<environment_status>[\s\S]*?<\/environment_status>\n*/g;
const EVENT_BLOCK = /\n*<environment_event>[\s\S]*?<\/environment_event>\n*/g;

function stripOwnedBlocks(text: string): string {
  return text.replace(STATUS_BLOCK, '\n').replace(EVENT_BLOCK, '\n').trimEnd();
}

function cloneClean<T extends AnnotatableMessage>(messages: readonly T[]): T[] {
  return messages.map((message) => {
    if (typeof message.content === 'string') {
      return { ...message, content: stripOwnedBlocks(message.content) };
    }
    const content = message.content
      .map((part) => {
        const clone = { ...part };
        if (clone.type === 'text' && typeof clone['text'] === 'string') {
          clone['text'] = stripOwnedBlocks(clone['text']);
        }
        return clone;
      })
      .filter(
        (part) =>
          part.type !== 'text' ||
          typeof part['text'] !== 'string' ||
          part['text'].length > 0,
      );
    return { ...message, content };
  });
}

function appendBlock(message: AnnotatableMessage, block: string): void {
  if (typeof message.content === 'string') {
    message.content =
      message.content.length === 0 ? block : `${message.content}\n\n${block}`;
    return;
  }
  message.content = [...message.content, { type: 'text', text: block }];
}

export function renderStatusBlock(counts: SlackCounts): string {
  return [
    '<environment_status>',
    `  <slack unread="${counts.unread}" mentions="${counts.mentions}" />`,
    '</environment_status>',
  ].join('\n');
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function renderEventBlock(message: SlackMessageView): string {
  return [
    '<environment_event>',
    `  <slack_message id="${escapeXml(message.id)}" channel="${escapeXml(
      message.channel,
    )}" sender="${escapeXml(message.sender)}" sender_role="${escapeXml(
      message.senderRole,
    )}" mentions_agent="${message.mentionsAgent ? 'true' : 'false'}">`,
    `    ${escapeXml(message.text)}`,
    '  </slack_message>',
    '</environment_event>',
  ].join('\n');
}

export interface AnchoredAnnotation {
  anchor: AnchorKey;
  block: string;
  deliveredAtDecisionIndex: number;
  slackMessageId: string;
}

export interface AnnotationResult<T extends AnnotatableMessage> {
  messages: T[];
  statusBlock: string | undefined;
  statusAnchor: AnchorKey;
  appliedEventBlocks: AnchoredAnnotation[];
}

export function annotateMessages<T extends AnnotatableMessage>(
  source: readonly T[],
  options: { counts: SlackCounts; anchoredEvents: readonly AnchoredAnnotation[] },
): AnnotationResult<T> {
  const messages = cloneClean(source);
  const appliedEventBlocks: AnchoredAnnotation[] = [];

  for (const annotation of options.anchoredEvents) {
    const index = messages.findIndex((message, candidate) =>
      matches(message, candidate, annotation.anchor),
    );
    const target = messages[index];
    if (target !== undefined) {
      appendBlock(target, annotation.block);
      appliedEventBlocks.push(annotation);
    }
  }

  const statusAnchor = anchorKeyFor(messages);
  const statusBlock = renderStatusBlock(options.counts);
  const statusIndex = messages.findIndex((message, index) =>
    matches(message, index, statusAnchor),
  );
  const statusTarget = messages[statusIndex];
  if (statusAnchor !== NO_ANCHOR && statusTarget !== undefined) {
    appendBlock(statusTarget, statusBlock);
  }

  return {
    messages,
    statusBlock:
      statusAnchor !== NO_ANCHOR && statusTarget !== undefined ? statusBlock : undefined,
    statusAnchor,
    appliedEventBlocks,
  };
}

export function messageText(message: AnnotatableMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content
    .map((part) =>
      part.type === 'text' && typeof part['text'] === 'string' ? part['text'] : '',
    )
    .join('\n');
}

export function contextText(messages: readonly AnnotatableMessage[]): string {
  return messages.map(messageText).join('\n');
}
