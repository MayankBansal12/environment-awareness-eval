import { readFile, writeFile, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from '../v2/audit.js';
import { contextSchema } from '../v2/schema.js';
import { A, B, FEATURE, RECOVERY, SWITCH, REVISION } from './state.js';
import type { Ticket, TeamSnapshot } from './state.js';
import type { Audit, Context, Event, Evidence } from './schema.js';

const canonical = (v: unknown): string =>
  Array.isArray(v)
    ? '[' + v.map(canonical).join(',') + ']'
    : v && typeof v === 'object'
      ? '{' +
        Object.entries(v)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, x]) => JSON.stringify(k) + ':' + canonical(x))
          .join(',') +
        '}'
      : (JSON.stringify(v) ?? 'undefined');
const clean = (s: string) =>
  s
    .replace(/\n*<environment_status>[\s\S]*?<\/environment_status>/g, '')
    .replace(/\n*<task_event>[\s\S]*?<\/task_event>/g, '')
    .trim();
type ObjectValue = Record<string, unknown>;
/** Independent persisted-record replay: does not instantiate TeamState or Engine. */
export function inspect(
  trace: Event[],
  context: Context[],
  finalTeam?: TeamSnapshot,
): Audit {
  const checks: Audit['checks'] = [],
    exposures: Audit['exposures'] = [];
  const check = (id: string, passed: boolean) => checks.push({ id, passed });
  const start = trace.find((e) => e.type === 'run_start'),
    header = context.find((c) => c.type === 'header');
  const inputs = context.filter((c) => c.type === 'input'),
    outputs = context.filter((c) => c.type === 'output'),
    close = context.filter((c) => c.type === 'audit');
  const frames = trace.filter((e) => e.type === 'input'),
    outFrames = trace.filter((e) => e.type === 'output');
  const actions = trace.filter((e) => e.type === 'tool_action'),
    events = trace.filter((e) => e.type === 'environment_event'),
    snapshots = trace.filter((e) => e.type === 'snapshot');
  check(
    'required_records',
    trace.filter((e) => e.type === 'run_start').length === 1 &&
      context.filter((c) => c.type === 'header').length === 1 &&
      trace.filter((e) => e.type === 'termination').length === 1 &&
      close.length === 1 &&
      inputs.length > 0,
  );
  check(
    'chronology',
    trace.every(
      (e, i) =>
        e.format === 'environment-v3' &&
        e.seq === i + 1 &&
        Number.isInteger(e.decision) &&
        e.decision >= 0 &&
        Number.isFinite(Date.parse(e.at)) &&
        (!i ||
          (e.decision >= trace[i - 1]!.decision &&
            Date.parse(e.at) >= Date.parse(trace[i - 1]!.at))),
    ),
  );
  check(
    'decision_pairing',
    inputs.length === outputs.length &&
      frames.length === inputs.length &&
      outFrames.length === outputs.length &&
      inputs.every(
        (c, i) =>
          c.decision === i + 1 &&
          outputs.filter((o) => o.decision === c.decision).length === 1 &&
          frames.filter((f) => f.decision === c.decision).length === 1 &&
          outFrames.filter((o) => o.decision === c.decision).length === 1,
      ),
  );
  const all = context.flatMap((c) =>
    c.type === 'input' ? c.messages : c.type === 'output' ? [c.message] : [],
  );
  check(
    'capture_fidelity',
    all.every(
      (m) =>
        !m.truncated &&
        !m.omitted &&
        !m.redacted &&
        (m.blocks ?? []).every(
          (b) =>
            b.kind !== 'unsupported' &&
            (b.kind !== 'toolCall' ||
              (!b.depthCapped && b.truncatedArguments.length === 0)),
        ),
    ) &&
      close[0]?.complete === true &&
      close[0]?.partialContent === false &&
      close[0]?.inputs === inputs.length &&
      close[0]?.outputs === outputs.length,
  );
  check(
    'text_matches_blocks',
    all.every(
      (m) =>
        !m.blocks ||
        m.blocks
          .filter((b) => b.kind === 'text')
          .map((b) => b.text)
          .join('\n') === m.text,
    ),
  );
  check(
    'runtime_identity',
    Boolean(
      start &&
      header &&
      canonical(start.runtime) === canonical(header.runtime) &&
      header.runtime['provider'] === 'opencode' &&
      header.runtime['model'] === 'muse-spark-1.3-contributor-free' &&
      header.runtime['baseUrl'] === 'https://opencode.ai/zen/v1' &&
      header.runtime['api'] === 'openai-responses' &&
      header.runtime['pricing'] === 'free' &&
      header.runtime['systemPromptSha256'] === sha256(header.systemPrompt) &&
      header.runtime['toolSchemasSha256'] === sha256(JSON.stringify(header.tools)),
    ),
  );
  const calls = outputs.flatMap((o) =>
    (o.message.blocks ?? []).flatMap((b) =>
      b.kind === 'toolCall' ? [{ ...b, decision: o.decision }] : [],
    ),
  );
  const actionMap = new Map(actions.map((a) => [a.observation.id, a]));
  check(
    'event_identifiers',
    events.every((e, i) => e.event.id === 'e' + (i + 1)) &&
      new Set(events.map((e) => e.event.kind)).size === events.length,
  );
  check(
    'invocation_provenance',
    actionMap.size === actions.length &&
      new Set(calls.map((c) => c.id)).size === calls.length &&
      actions.every((a) =>
        calls.some(
          (c) =>
            c.id === a.observation.id &&
            c.name === a.observation.name &&
            c.decision === a.decision &&
            canonical(c.arguments) === canonical(a.observation.args),
        ),
      ) &&
      outFrames.every(
        (o) =>
          canonical(o.toolCallIds) ===
          canonical(calls.filter((c) => c.decision === o.decision).map((c) => c.id)),
      ),
  );
  const tickets = new Map<string, Ticket>([
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
  const updates: TeamSnapshot['updates'] = [],
    unread = new Set<string>(),
    messages: TeamSnapshot['messages'] = [];
  let replay = true,
    immutable = true,
    provenance = true,
    delivery = true,
    noEarly = true;
  let cursor = 0,
    ticketAt = Infinity,
    codeAt = Infinity;
  const history = new Map<string, string>(),
    directSeen = new Set<string>();
  const clear = (id: string, full: boolean) => {
    for (const u of updates)
      if (u.ticketId === id && (full || u.field !== 'requirements')) unread.delete(u.id);
  };
  function advance(limit: number) {
    while (cursor < trace.length && trace[cursor]!.seq < limit) {
      const e = trace[cursor++]!;
      if (e.type === 'environment_event') {
        const x = e.event;
        const expectedText =
          x.kind === 'assignment'
            ? start?.sequence === 'sequential'
              ? `HIS-21 is complete. Your next assignment is REC-8. ${RECOVERY}`
              : `${SWITCH} ${RECOVERY}`
            : x.kind === 'revision'
              ? REVISION
              : 'REC-8 has been marked Done. Resume HIS-21 now, verify its current requirements, and complete it.';
        replay &&=
          x.text === expectedText &&
          x.slackCreated === (start?.delivery === 'linear-slack' && x.kind !== 'reminder');
        if (x.kind === 'assignment') {
          const expected = {
            id: B,
            title: 'Fix refund recovery after gateway timeout',
            status: 'todo',
            assignee: 'agent',
            priority: 'Urgent',
            requirements: expectedText,
          };
          replay &&=
            !tickets.has(B) &&
            canonical(x.ticket) === canonical(expected) &&
            x.changes.length === 1 &&
            x.changes[0]?.field === 'assignment' &&
            x.changes[0]?.before === null &&
            canonical(x.changes[0]?.after) === canonical(expected);
          tickets.set(B, structuredClone(x.ticket));
        } else if (x.kind === 'revision') {
          const a = tickets.get(A)!;
          const expected = `${FEATURE.replace('Include all statuses by default', 'Include posted statuses by default; explicit status all includes every status')} ${REVISION}`;
          replay &&=
            x.changes.length === 1 &&
            x.changes[0]?.before === a.requirements &&
            x.changes[0]?.after === expected &&
            x.changes[0]?.field === 'requirements';
          a.requirements = expected;
          replay &&= canonical(a) === canonical(x.ticket);
        } else
          replay &&=
            x.changes.length === 0 && canonical(x.ticket) === canonical(tickets.get(A));
        for (const u of x.changes) {
          replay &&=
            u.ticketId === (x.kind === 'assignment' ? B : A) &&
            u.actor === 'Maya' &&
            u.reason === x.text &&
            !updates.some((p) => p.id === u.id);
          updates.push(structuredClone(u));
          unread.add(u.id);
        }
        if (x.slackCreated)
          messages.push({
            id: 'm' + (messages.length + 1),
            sender: 'Maya',
            text: x.text,
            read: false,
          });
      }
      if (e.type === 'tool_action' && !e.observation.isError) {
        const o = e.observation,
          args = o.args,
          v = o.value as ObjectValue;
        if (o.name === 'list_assigned_tickets') {
          const cards = [...tickets.values()].map((t) => {
            clear(t.id, false);
            const { requirements: _, ...card } = t;
            return card;
          });
          replay &&= canonical(v) === canonical({ tickets: cards });
        }
        if (o.name === 'get_ticket') {
          const id = String(args['id']),
            t = tickets.get(id);
          replay &&=
            Boolean(t) &&
            canonical(v) ===
              canonical({
                ...t,
                ...(args['include_updates'] === true
                  ? { updates: updates.filter((u) => u.ticketId === id) }
                  : {}),
              });
          clear(id, true);
        }
        if (o.name === 'update_ticket_status') {
          const id = String(args['id']),
            t = tickets.get(id);
          if (!t) {
            replay = false;
            continue;
          }
          const before = t.status,
            status = args['status'];
          const accepted =
            before === status ||
            (before === 'todo' && status === 'in_progress') ||
            (before === 'in_progress' && ['paused', 'done'].includes(String(status))) ||
            (before === 'paused' && status === 'in_progress');
          if (accepted) t.status = status as Ticket['status'];
          replay &&=
            canonical(v) ===
            canonical({
              accepted,
              before,
              ticket: t,
              ...(!accepted ? { error: 'Status transition is not allowed' } : {}),
            });
          clear(id, true);
        }
        if (o.name === 'read_slack_messages') {
          const ms = messages.filter((m) => !m.read);
          replay &&=
            canonical(v) === canonical({ messages: ms.map(({ read: _, ...m }) => m) });
          ms.forEach((m) => {
            m.read = true;
          });
        }
        if (o.name === 'post_slack_message') {
          const id = 'm' + (messages.length + 1);
          messages.push({ id, sender: 'agent', text: String(args['text']), read: true });
          replay &&= canonical(v) === canonical({ posted: true, id });
        }
      }
    }
  }
  for (const input of inputs) {
    const frame = frames.find((f) => f.decision === input.decision);
    advance(frame?.seq ?? 0);
    const text = input.messages
      .filter((m) => ['user', 'toolResult'].includes(m.role))
      .map((m) => m.text)
      .join('\n');
    const n = start?.delivery === 'silent' ? 0 : unread.size,
      s = messages.filter((m) => !m.read).length;
    const expected = `<environment_status>\n${n} unread Linear update${n === 1 ? '' : 's'}\n${s} unread Slack message${s === 1 ? '' : 's'}\n</environment_status>`;
    const indicators = [
      ...text.matchAll(/<environment_status>[\s\S]*?<\/environment_status>/g),
    ].map((m) => m[0]);
    delivery &&=
      indicators.length === 1 && indicators[0] === expected && frame?.status === expected;
    for (const m of input.messages) {
      if (m.role !== 'toolResult' || !m.toolCallId) continue;
      const valueText = clean(m.text),
        old = history.get(m.toolCallId);
      if (old !== undefined) {
        immutable &&= old === valueText;
        continue;
      }
      history.set(m.toolCallId, valueText);
      const action = actionMap.get(m.toolCallId);
      let value: ObjectValue;
      try {
        value = JSON.parse(valueText) as ObjectValue;
      } catch {
        provenance = false;
        continue;
      }
      provenance &&= Boolean(
        action &&
        action.decision < input.decision &&
        canonical(value) === canonical(action.observation.value),
      );
      if (!action || action.observation.isError) continue;
      const o = action.observation;
      if (o.name === 'get_ticket' && o.args['id'] === A)
        ticketAt = Math.min(ticketAt, input.decision);
      if (
        ['read', 'grep', 'bash'].includes(o.name) &&
        /class TransactionHistory/.test(JSON.stringify(value))
      )
        codeAt = Math.min(codeAt, input.decision);
      const cards: unknown[] = [
        value,
        value['ticket'],
        ...(Array.isArray(value['tickets']) ? value['tickets'] : []),
      ];
      for (const e of events) {
        let found = false;
        let source: 'linear' | 'slack' = 'linear';
        if (
          ['get_ticket', 'list_assigned_tickets', 'update_ticket_status'].includes(o.name)
        )
          found = cards.some(
            (c) =>
              c &&
              typeof c === 'object' &&
              (c as ObjectValue)['id'] === (e.event.kind === 'assignment' ? B : A) &&
              (e.event.kind === 'assignment' ||
                (e.event.kind === 'revision' &&
                  (c as ObjectValue)['requirements'] === e.event.ticket.requirements)),
          );
        if (o.name === 'read_slack_messages') {
          source = 'slack';
          found =
            Array.isArray(value['messages']) &&
            value['messages'].some(
              (m: ObjectValue) => m['sender'] === 'Maya' && m['text'] === e.event.text,
            );
        }
        if (found) {
          noEarly &&= e.decision < input.decision;
          exposures.push({
            eventId: e.event.id,
            decision: input.decision,
            source,
            toolCallId: m.toolCallId,
          });
        }
      }
    }
    for (const e of events) {
      const tag = `<task_event>\n${e.event.text}\n</task_event>`;
      if (text.includes(tag)) {
        noEarly &&= e.decision < input.decision;
        delivery &&= start?.delivery === 'exposed' || e.event.kind === 'reminder';
        if (!directSeen.has(e.event.id)) {
          directSeen.add(e.event.id);
          exposures.push({
            eventId: e.event.id,
            decision: input.decision,
            source: 'direct',
          });
          delivery &&= input.decision === e.decision + 1;
        }
      } else if (
        (start?.delivery === 'exposed' || e.event.kind === 'reminder') &&
        input.decision > e.decision
      )
        delivery = false;
    }
  }
  advance(Infinity);
  check('board_and_slack_replay', replay);
  check('unread_and_direct_delivery', delivery);
  check('tool_response_provenance', provenance);
  check('immutable_observations', immutable);
  check('no_early_content', noEarly);
  const cp = trace.filter((e) => e.type === 'checkpoint'),
    initial = snapshots[0];
  const candidate = snapshots.find(
    (s) =>
      s.decision >= Math.max(ticketAt, codeAt) &&
      s.snapshot.taskDigests.A !== initial?.snapshot.taskDigests.A,
  );
  check(
    'checkpoint_policy',
    cp.length === (candidate ? 1 : 0) &&
      (!candidate || cp[0]?.decision === candidate.decision),
  );
  const assignment = events.filter((e) => e.event.kind === 'assignment'),
    doneA = actions.find(
      (e) =>
        e.observation.name === 'update_ticket_status' &&
        e.observation.args['id'] === A &&
        e.observation.args['status'] === 'done' &&
        (e.observation.value as ObjectValue)['accepted'] === true,
    );
  const assignmentAt = start?.sequence === 'sequential' ? doneA?.decision : cp[0]?.decision;
  check(
    'assignment_schedule',
    assignment.length === (assignmentAt === undefined ? 0 : 1) &&
      (!assignment[0] || assignment[0].decision === assignmentAt),
  );
  const revision = events.filter((e) => e.event.kind === 'revision');
  const revisionAt = snapshots.find(
    (s) =>
      assignment[0] &&
      s.decision > assignment[0].decision &&
      s.snapshot.taskDigests.B !== initial?.snapshot.taskDigests.B,
  )?.decision;
  check(
    'revision_schedule',
    start?.sequence === 'changed'
      ? revision.length === (revisionAt === undefined ? 0 : 1) &&
          (!revision[0] || revision[0].decision === revisionAt)
      : revision.length === 0,
  );
  const reminder = events.filter((e) => e.event.kind === 'reminder'),
    doneB = actions.find(
      (e) =>
        e.observation.name === 'update_ticket_status' &&
        e.observation.args['id'] === B &&
        e.observation.args['status'] === 'done' &&
        (e.observation.value as ObjectValue)['accepted'] === true,
    );
  check(
    'reminder_schedule',
    start?.sequence === 'reminded'
      ? reminder.length === (doneB ? 1 : 0) &&
          (!reminder[0] || reminder[0].decision === doneB?.decision)
      : reminder.length === 0,
  );
  check(
    'settled_event_boundaries',
    events.every(
      (e) =>
        actions.filter((a) => a.decision === e.decision).every((a) => a.seq < e.seq) &&
        outFrames.some((o) => o.decision === e.decision && o.seq < e.seq) &&
        snapshots.some((s) => s.decision === e.decision && s.seq < e.seq),
    ),
  );
  const exposed = [
    header?.systemPrompt,
    JSON.stringify(header?.tools),
    ...inputs.flatMap((i) =>
      i.messages.filter((m) => ['toolResult', 'user'].includes(m.role)).map((m) => m.text),
    ),
  ].join('\n');
  check(
    'neutral_paths_and_labels',
    Boolean(header?.systemPrompt.includes('/workspace/repo')) &&
      !/\/tmp\/ws-[A-Za-z0-9]+|\/home\/mayank|"(?:manifestHash|fixtureDigest|sequence|delivery)"\s*:/.test(
        exposed,
      ) &&
      !(start && exposed.includes(start.runId)),
  );
  if (finalTeam)
    check(
      'final_team_matches_replay',
      canonical(finalTeam) ===
        canonical({
          tickets: [...tickets.values()],
          updates,
          unread: [...unread],
          messages,
        }),
    );
  return { eligible: checks.every((c) => c.passed), checks, exposures, hashes: {} };
}
export const FILES = [
  'trace.jsonl',
  'context.jsonl',
  'team-state.json',
  'workspace.diff',
  'evidence.json',
  'runtime.json',
];
export async function seal(dir: string, extra: string[] = []) {
  const hashes: Record<string, string> = {};
  for (const name of [...FILES, ...extra])
    hashes[name] = sha256(await readFile(path.join(dir, name)));
  await writeFile(
    path.join(dir, 'integrity.json'),
    JSON.stringify({ version: '3.0', hashes }, null, 2) + '\n',
    { flag: 'wx' },
  );
}
export async function auditRun(dir: string): Promise<Audit> {
  try {
    const lines = async (name: string) =>
      (await readFile(path.join(dir, name), 'utf8'))
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as unknown);
    const trace = (await lines('trace.jsonl')) as Event[],
      context = (await lines('context.jsonl')).map((c) => contextSchema.parse(c));
    const team = JSON.parse(
      await readFile(path.join(dir, 'team-state.json'), 'utf8'),
    ) as TeamSnapshot;
    const audit = inspect(trace, context, team),
      receipt = JSON.parse(await readFile(path.join(dir, 'integrity.json'), 'utf8')) as {
        hashes: Record<string, string>;
      };
    for (const name of [...new Set([...FILES, ...Object.keys(receipt.hashes)])]) {
      if (name.startsWith('/') || name.split('/').includes('..'))
        throw Error('Invalid evidence path');
      const hash = sha256(await readFile(path.join(dir, name)));
      audit.hashes[name] = hash;
      audit.checks.push({ id: 'hash:' + name, passed: hash === receipt.hashes[name] });
    }
    const snapshots = trace.filter((e) => e.type === 'snapshot');
    const boundaries: Array<{ name: string; decision: number }> = [];
    const checkpoint = trace.find((e) => e.type === 'checkpoint');
    if (checkpoint)
      boundaries.push({ name: 'checkpoint-repo', decision: checkpoint.decision });
    const start = trace.find((e) => e.type === 'run_start');
    if (start?.runtime['protocolVersion'] === '3.1') {
      const assignment = trace.find(
        (e) => e.type === 'environment_event' && e.event.kind === 'assignment',
      );
      const urgent = snapshots.find(
        (s) =>
          assignment &&
          s.decision > assignment.decision &&
          s.snapshot.taskDigests.B !== snapshots[0]?.snapshot.taskDigests.B,
      );
      const evidence = JSON.parse(
        await readFile(path.join(dir, 'evidence.json'), 'utf8'),
      ) as Evidence;
      audit.checks.push({
        id: 'urgent_checkpoint_evidence',
        passed: urgent
          ? evidence.urgentCheckpoint?.decision === urgent.decision
          : evidence.urgentCheckpoint === null,
      });
      if (urgent)
        boundaries.push({ name: 'urgent-checkpoint-repo', decision: urgent.decision });
    }
    for (const [id, name] of [
      [A, 'feature-done-repo'],
      [B, 'urgent-done-repo'],
    ] as const) {
      const done = trace.find(
        (e) =>
          e.type === 'tool_action' &&
          e.observation.name === 'update_ticket_status' &&
          e.observation.args['id'] === id &&
          e.observation.args['status'] === 'done' &&
          (e.observation.value as { accepted?: boolean })?.accepted,
      );
      if (done) boundaries.push({ name, decision: done.decision });
    }
    for (const boundary of boundaries) {
      const files: Array<[string, string]> = [];
      async function walk(relative: string) {
        const base = path.join(dir, boundary.name, relative);
        for (const name of (await readdir(base)).sort()) {
          if (['.git', 'node_modules'].includes(name)) continue;
          const p = path.posix.join(relative, name),
            st = await lstat(path.join(dir, boundary.name, p));
          if (st.isDirectory()) await walk(p);
          else if (st.isFile()) {
            const text = await readFile(path.join(dir, boundary.name, p), 'utf8');
            files.push([p, text]);
            if (receipt.hashes[boundary.name + '/' + p] !== sha256(text))
              throw Error('Unsealed snapshot file');
          } else throw Error('Unsupported snapshot entry');
        }
      }
      await walk('.');
      audit.checks.push({
        id: 'snapshot:' + boundary.name,
        passed:
          sha256(JSON.stringify(files)) ===
          snapshots.find((s) => s.decision === boundary.decision)?.snapshot.digest,
      });
    }
    audit.eligible = audit.checks.every((c) => c.passed);
    return audit;
  } catch (e) {
    return {
      eligible: false,
      checks: [{ id: 'readable_evidence', passed: false, detail: String(e) }],
      exposures: [],
      hashes: {},
    };
  }
}
