import { afterEach, describe, it, expect } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ControlledTools } from '../src/harness/repo-tools.js';
import { RunSandbox } from '../src/harness/sandbox.js';
import { FAMILIES } from '../src/scenario.js';
import { TeamState } from '../src/state.js';

// Runs require unprivileged user namespaces (Ubuntu 24.04 needs an AppArmor profile for bwrap).
const bwrap =
  spawnSync('/usr/bin/bwrap', ['--unshare-all', '--ro-bind', '/', '/', 'true']).status ===
  0;

const environments: RunSandbox[] = [];
async function create() {
  const s = await RunSandbox.create();
  environments.push(s);
  return s;
}
afterEach(async () => {
  await Promise.all(environments.splice(0).map((s) => s.dispose()));
});

describe.skipIf(!bwrap)('enforced execution boundary', () => {
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
      /settlement|fulfillment|ambient|exposed|environment-awareness-eval|results\//,
    );
  });
  it('serves each tool request ID once and keeps team state bound to its run', async () => {
    const a = await create(),
      b = await create();
    const sa = new TeamState(FAMILIES.settlement, 'ambient'),
      sb = new TeamState(FAMILIES.settlement, 'ambient');
    let calls = 0;
    const tools = new ControlledTools(a, sa, () => calls++);
    const other = new ControlledTools(b, sb, () => {});
    const post = { channel: '#payments-eng', text: 'status' };
    const [x, y] = await Promise.all([
      tools.run('once', 'slack_post', post),
      tools.run('once', 'slack_post', post),
    ]);
    expect(x).toEqual(y);
    expect(calls).toBe(1);
    expect(sa.snapshot().messages).toHaveLength(1);
    expect(sb.snapshot().messages).toHaveLength(0);
    await expect(
      tools.run('once', 'slack_post', { ...post, text: 'different' }),
    ).rejects.toThrow();
    await tools.run('write', 'write', { path: 'test.txt', content: 'old' });
    await tools.run('edit', 'edit', { path: 'test.txt', oldText: 'old', newText: 'new' });
    expect(await readFile(path.join(a.repo, 'test.txt'), 'utf8')).toBe('new');
    expect((await other.run('read', 'read', { path: 'test.txt' })).isError).toBe(true);
  });
});
