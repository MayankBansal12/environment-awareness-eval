import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { ControlledTools } from '../v2/tools.js';

export function definitions(tools: ControlledTools): ToolDefinition[] {
  return tools.definitions().map((d) => {
    if (d.name === 'list_assigned_tickets')
      return {
        ...d,
        description:
          'List current assigned Linear cards. Returned assignment/status changes are marked seen; unseen requirement changes remain unread until full ticket details are returned.',
      };
    if (d.name !== 'update_ticket_status') return d;
    return defineTool({
      name: d.name,
      label: d.name,
      description:
        'Update ticket status: todo to in_progress, in_progress to paused or done, paused to in_progress, or retain current status. Returns current full ticket details and marks that ticket seen. Status does not certify code correctness.',
      parameters: Type.Object({
        id: Type.String(),
        status: Type.Union(
          ['todo', 'in_progress', 'paused', 'done', 'cancelled'].map((s) =>
            Type.Literal(s),
          ),
        ),
      }),
      execute: async (id, args, signal) => {
        const o = await tools.run(id, d.name, args, signal);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(o.value) }],
          details: { isError: o.isError },
        };
      },
    }) as ToolDefinition;
  });
}
