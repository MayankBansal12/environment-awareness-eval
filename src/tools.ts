import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type, type TSchema } from 'typebox';
import type { ControlledTools } from './harness/repo-tools.js';
import { statusSchema } from './state.js';

const REPO_TOOLS = ['read', 'write', 'edit', 'grep', 'find', 'ls', 'bash'];

const TEAM_TOOLS: Array<{ name: string; description: string; parameters: TSchema }> = [
  {
    name: 'linear_list_my_issues',
    description: 'List Linear issues assigned to you with status, priority and labels.',
    parameters: Type.Object({}),
  },
  {
    name: 'linear_get_issue',
    description:
      'Get a Linear issue by id, including description, status, priority, labels and comments. Marks its inbox notifications read.',
    parameters: Type.Object({ id: Type.String() }),
  },
  {
    name: 'linear_inbox',
    description: 'List unread Linear inbox notifications and mark them read.',
    parameters: Type.Object({}),
  },
  {
    name: 'linear_update_issue_status',
    description: 'Set the status of an issue assigned to you.',
    parameters: Type.Object({
      id: Type.String(),
      status: Type.Union(statusSchema.options.map((s) => Type.Literal(s))),
    }),
  },
  {
    name: 'linear_comment',
    description: 'Add a comment to a Linear issue.',
    parameters: Type.Object({
      id: Type.String(),
      body: Type.String({ minLength: 1, maxLength: 12000 }),
    }),
  },
  {
    name: 'slack_read',
    description: 'Read unread Slack messages from your channels and mark them read.',
    parameters: Type.Object({}),
  },
  {
    name: 'slack_search',
    description:
      'Search Slack message history, including read messages, by a text substring (case insensitive).',
    parameters: Type.Object({ query: Type.String({ minLength: 1 }) }),
  },
  {
    name: 'slack_post',
    description: 'Post a message to a Slack channel.',
    parameters: Type.Object({
      channel: Type.String({ minLength: 1, maxLength: 80 }),
      text: Type.String({ minLength: 1, maxLength: 12000 }),
    }),
  },
];

/** Repository tools run in the sandbox; team tools route to the simulated Linear and Slack. */
export function definitions(tools: ControlledTools): ToolDefinition[] {
  const repo = tools.definitions().filter((d) => REPO_TOOLS.includes(d.name));
  const team = TEAM_TOOLS.map(
    (d) =>
      defineTool({
        ...d,
        label: d.name,
        execute: async (id, params, signal) => {
          const o = await tools.run(id, d.name, params as Record<string, unknown>, signal);
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(o.value) }],
            details: { isError: o.isError },
          };
        },
      }) as ToolDefinition,
  );
  return [...repo, ...team];
}
