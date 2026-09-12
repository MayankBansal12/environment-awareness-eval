import { afterEach, describe, it, expect } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { RunSandbox } from '../src/v2/sandbox.js';
import { prepareFixture, applyReference, HIDDEN_PROBES } from '../src/v2/fixture.js';
import { TeamState } from '../src/v2/state.js';
import { ControlledTools } from '../src/v2/tools.js';
import { snapshot } from '../src/v2/engine.js';

const environments: RunSandbox[] = [];
async function create() {
  const s = await RunSandbox.create();
  environments.push(s);
  return s;
}
afterEach(async () => {
  await Promise.all(environments.splice(0).map((s) => s.dispose()));
});

describe('enforced execution boundary', () => {
  it('isolates concurrent repos, home/tmp, host processes, environment, and network', async () => {
    const [a, b] = await Promise.all([create(), create()]);
    await writeFile(path.join(a.repo, 'private'), 'a');
    await writeFile(path.join(b.repo, 'private'), 'b');
    const script = `const fs=require('node:fs');console.log(JSON.stringify({cwd:process.cwd(),value:fs.readFileSync('private','utf8'),host:fs.existsSync('/home/mayank'),other:fs.existsSync(${JSON.stringify(b.repo)}),controller:fs.existsSync(${JSON.stringify(process.cwd())}),env:Object.keys(process.env),names:fs.readdirSync('/proc').filter(n=>/^\\d+$/.test(n))}));`;
    const [ra, rb] = await Promise.all([
      a.exec(['node', '-e', script]),
      b.shell('cat private; echo test > /tmp/unique; echo test > "$HOME/unique"'),
    ]);
    expect(ra.exitCode).toBe(0);
    expect(rb.stdout.trim()).toBe('b');
    const result = JSON.parse(ra.stdout);
    expect(result).toMatchObject({
      cwd: '/workspace/repo',
      value: 'a',
      host: false,
      other: false,
      controller: false,
    });
    expect(result.env.some((v: string) => /TOKEN|KEY|BB_|PI_|CODEX/.test(v))).toBe(false);
    expect(
      (await a.shell('test ! -e /tmp/unique && test ! -e "$HOME/unique"')).exitCode,
    ).toBe(0);
    expect((await a.shell(`cat ${b.repo}/private`)).exitCode).not.toBe(0);
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw Error('address');
      const net = await a.exec([
        'node',
        '-e',
        `require('node:net').connect(${addr.port},'127.0.0.1').on('connect',()=>process.exit(9)).on('error',()=>process.exit(0));`,
      ]);
      expect(net.exitCode).toBe(0);
    } finally {
      server.close();
    }
    const child = await a.shell(
      '(sleep 1; echo leaked > /workspace/repo/background) >/dev/null 2>&1 &',
    );
    expect(child.exitCode).toBe(0);
    await a
      .shell('sleep 1.2; test ! -e background')
      .then((r) => expect(r.exitCode).toBe(0));
  });
  it('bounds commands, blocks symlink escapes, and provides no condition clues', async () => {
    const a = await create();
    await a.shell('ln -s /home/mayank outside');
    expect((await a.shell('ls outside/')).exitCode).not.toBe(0);
    expect((await a.exec(['sleep', '10'], { timeoutMs: 100 })).timedOut).toBe(true);
    const env = await a.shell('pwd; env; cat /proc/1/cmdline');
    expect(env.stdout).not.toMatch(
      /cancel-ambient|higher|lower|linear-slack|environment-awareness-eval|results\//,
    );
  });
  it('serves each tool request ID once and keeps app state bound to its run', async () => {
    const a = await create(),
      b = await create();
    const sa = new TeamState('linear'),
      sb = new TeamState('linear');
    let calls = 0;
    const tools = new ControlledTools(a, sa, () => calls++);
    const other = new ControlledTools(b, sb, () => {});
    const [x, y] = await Promise.all([
      tools.run('once', 'post_slack_message', { text: 'status' }),
      tools.run('once', 'post_slack_message', { text: 'status' }),
    ]);
    expect(x).toEqual(y);
    expect(calls).toBe(1);
    expect(sa.slackHistory()).toHaveLength(1);
    expect(sb.slackHistory()).toHaveLength(0);
    await expect(
      tools.run('once', 'post_slack_message', { text: 'different' }),
    ).rejects.toThrow();
    await tools.run('write', 'write', { path: 'test.txt', content: 'old' });
    await tools.run('edit', 'edit', { path: 'test.txt', oldText: 'old', newText: 'new' });
    expect(await readFile(path.join(a.repo, 'test.txt'), 'utf8')).toBe('new');
    expect((await other.run('read', 'read', { path: 'test.txt' })).isError).toBe(true);
    sa.cancel();
    expect(
      (await other.run('ticket', 'get_ticket', { id: 'REF-14' })).value,
    ).toHaveProperty('status', 'todo');
  });
});

describe.each(['lower', 'higher'] as const)('%s demand reference calibration', (demand) => {
  it('starts red, leaves a missing API requirement after the first repair, and has a passing complete solution', async () => {
    const s = await create();
    const seed = await prepareFixture(s, demand);
    const before = await snapshot(s, seed.commit);
    expect((await s.exec(['npm', 'test'])).exitCode).not.toBe(0);
    const original = await s.exec(['node', '--input-type=module'], {
      stdin: HIDDEN_PROBES,
      readOnly: true,
    });
    const initialChecks = JSON.parse(original.stdout);
    expect(
      initialChecks.find((c: { id: string }) => c.id === 'retry_identity').passed,
    ).toBe(false);
    await applyReference(s, demand, true);
    const middle = await snapshot(s, seed.commit);
    expect(middle.implementationDigest).not.toBe(before.implementationDigest);
    expect((await s.exec(['npm', 'test'])).exitCode).not.toBe(0);
    await applyReference(s, demand);
    expect((await s.exec(['npm', 'test'])).exitCode).toBe(0);
    const hidden = await s.exec(['node', '--input-type=module'], {
      stdin: HIDDEN_PROBES,
      readOnly: true,
    });
    expect(hidden.exitCode).toBe(0);
    expect(JSON.parse(hidden.stdout).every((c: { passed: boolean }) => c.passed)).toBe(
      true,
    );
    expect((await s.shell('git add . && git commit -qm "Repair refunds"')).exitCode).toBe(
      0,
    );
    expect((await snapshot(s, seed.commit)).commits).toHaveLength(1);
    expect((await s.shell('git remote')).stdout).toBe('');
  });
});
