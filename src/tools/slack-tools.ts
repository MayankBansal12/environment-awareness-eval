/**
 * The simulated Slack tools.
 *
 * The behaviour lives in plain functions so it can be unit-tested without Pi or any model
 * call; `createSlackTools` is the only Pi-specific part and just wraps them.
 *
 * Tool descriptions are deliberately neutral. They describe an ordinary team messaging
 * tool and say nothing about monitoring, interruptions, or the experiment.
 */

import { Type } from 'typebox';

import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';

import type { SlackMessageView, SlackState } from '../engine/slack.js';

export interface ReadSlackResult {
  channel: string;
  messages: SlackMessageView[];
  readCursorAfter: number;
}

/**
 * Return every unread message in monotonic id order and mark exactly those as read.
 *
 * Marking happens inside `SlackState.readUnread()` and only covers messages actually
 * included in the returned batch.
 */
export function readSlackMessages(state: SlackState): ReadSlackResult {
  const messages = state.readUnread();
  return { channel: state.channel, messages, readCursorAfter: state.readCursor };
}

export interface PostSlackResult {
  messageId: string;
  channel: string;
  text: string;
}

export function postSlackMessage(
  state: SlackState,
  text: string,
  logicalTime: number,
): PostSlackResult {
  const message = state.post({
    sender: 'agent',
    senderRole: 'agent',
    text,
    mentionsAgent: false,
    logicalTime,
    // The agent's own post must never show up as unread to itself.
    markReadImmediately: true,
  });
  return { messageId: message.id, channel: message.channel, text: message.text };
}

export function formatReadResult(result: ReadSlackResult): string {
  if (result.messages.length === 0) {
    return JSON.stringify({ channel: result.channel, messages: [] }, null, 2);
  }
  return JSON.stringify(
    {
      channel: result.channel,
      messages: result.messages.map((message) => ({
        id: message.id,
        from: message.sender,
        role: message.senderRole,
        mentions_you: message.mentionsAgent,
        text: message.text,
      })),
    },
    null,
    2,
  );
}

export interface SlackToolDeps {
  state: SlackState;
  /** Current logical decision index, used as the message's logical time. */
  logicalTime: () => number;
  onRead: (result: ReadSlackResult, toolCallId: string) => void;
  onPost: (result: PostSlackResult, toolCallId: string) => void;
}

export const READ_SLACK_TOOL = 'read_slack_messages';
export const POST_SLACK_TOOL = 'post_slack_message';

export function createSlackTools(deps: SlackToolDeps): ToolDefinition[] {
  const readTool = defineTool({
    name: READ_SLACK_TOOL,
    label: 'Read Slack',
    description:
      'Read unread messages from the team Slack channel. Returns messages in the order they were sent and marks the returned messages as read.',
    promptSnippet: 'read unread messages from the team Slack channel',
    parameters: Type.Object({}),
    execute: async (toolCallId: string) => {
      const result = readSlackMessages(deps.state);
      deps.onRead(result, toolCallId);
      return {
        content: [{ type: 'text' as const, text: formatReadResult(result) }],
        details: { returnedMessageIds: result.messages.map((message) => message.id) },
      };
    },
  });

  const postTool = defineTool({
    name: POST_SLACK_TOOL,
    label: 'Post to Slack',
    description:
      'Post a message to the team Slack channel, for example to acknowledge a request or report status.',
    promptSnippet: 'post a message to the team Slack channel',
    parameters: Type.Object({
      text: Type.String({ description: 'The message text to post.' }),
    }),
    execute: async (toolCallId: string, params: { text: string }) => {
      const result = postSlackMessage(deps.state, params.text, deps.logicalTime());
      deps.onPost(result, toolCallId);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ posted: true, id: result.messageId }, null, 2),
          },
        ],
        details: { messageId: result.messageId },
      };
    },
  });

  return [readTool as ToolDefinition, postTool as ToolDefinition];
}
