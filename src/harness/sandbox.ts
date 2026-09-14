import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const AGENT_CWD = '/workspace/repo';
export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
  timedOut: boolean;
}

/** Fail-closed Linux namespace boundary. Only the explicit binds enter each tool process. */
export class RunSandbox {
  private active = new Set<number>();
  private closed = false;
  private constructor(
    readonly root: string,
    readonly repo: string,
  ) {}

  static async create(): Promise<RunSandbox> {
    const root = await mkdtemp(path.join(os.tmpdir(), 'ws-'));
    for (const name of ['repo', 'home', 'tmp', 'config'])
      await mkdir(path.join(root, name));
    await writeFile(
      path.join(root, 'config', 'passwd'),
      'agent:x:1000:1000:Agent:/home/agent:/bin/bash\n',
    );
    await writeFile(path.join(root, 'config', 'group'), 'agent:x:1000:\n');
    const sandbox = new RunSandbox(root, path.join(root, 'repo'));
    const probe = await sandbox.exec([
      'node',
      '-e',
      'console.log(process.cwd()); console.log(require("node:fs").existsSync("/home/mayank"))',
    ]);
    if (probe.exitCode !== 0 || probe.stdout.trim() !== `${AGENT_CWD}\nfalse`) {
      await sandbox.dispose();
      throw new Error('Required bubblewrap isolation is unavailable: ' + probe.stderr);
    }
    return sandbox;
  }

  async exec(
    argv: string[],
    options: {
      stdin?: string;
      timeoutMs?: number;
      signal?: AbortSignal;
      readOnly?: boolean;
    } = {},
  ): Promise<CommandResult> {
    if (this.closed) throw new Error('Execution environment is closed');
    if (options.signal?.aborted) throw new Error('Execution aborted');
    const args = [
      '--unshare-all',
      '--die-with-parent',
      '--new-session',
      '--cap-drop',
      'ALL',
      '--ro-bind',
      '/usr',
      '/usr',
      '--symlink',
      'usr/bin',
      '/bin',
      '--symlink',
      'usr/lib',
      '/lib',
      '--symlink',
      'usr/lib64',
      '/lib64',
      '--proc',
      '/proc',
      '--dev',
      '/dev',
      '--ro-bind',
      path.join(this.root, 'config'),
      '/etc',
      options.readOnly ? '--ro-bind' : '--bind',
      this.repo,
      AGENT_CWD,
      '--bind',
      path.join(this.root, 'home'),
      '/home/agent',
      '--bind',
      path.join(this.root, 'tmp'),
      '/tmp',
      '--chdir',
      AGENT_CWD,
      '--clearenv',
      '--setenv',
      'PATH',
      '/usr/bin:/bin',
      '--setenv',
      'HOME',
      '/home/agent',
      '--setenv',
      'TMPDIR',
      '/tmp',
      '--setenv',
      'LANG',
      'C.UTF-8',
      '--setenv',
      'GIT_CONFIG_NOSYSTEM',
      '1',
      '--setenv',
      'GIT_CONFIG_GLOBAL',
      '/dev/null',
      '--setenv',
      'GIT_TERMINAL_PROMPT',
      '0',
      '--setenv',
      'GIT_PAGER',
      'cat',
      '--',
      '/usr/bin/prlimit',
      '--as=2147483648',
      '--fsize=134217728',
      '--nofile=256',
      '--',
      ...argv,
    ];
    return new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/bwrap', args, {
        env: {},
        detached: true,
        stdio: 'pipe',
      });
      if (child.pid !== undefined) this.active.add(child.pid);
      let stdout = '',
        stderr = '',
        truncated = false,
        timedOut = false;
      const bound = 64_000;
      const stop = () => {
        if (child.pid) {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            /* exited */
          }
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, options.timeoutMs ?? 30_000);
      const onAbort = () => stop();
      options.signal?.addEventListener('abort', onAbort, { once: true });
      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        truncated ||= stdout.length + text.length > bound;
        stdout = (stdout + text).slice(0, bound);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        truncated ||= stderr.length + text.length > bound;
        stderr = (stderr + text).slice(0, bound);
      });
      child.stdin.on('error', () => {
        /* process may exit without reading stdin */
      });
      child.once('error', reject);
      child.once('close', (code) => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        if (child.pid) this.active.delete(child.pid);
        resolve({ stdout, stderr, exitCode: code ?? 137, truncated, timedOut });
      });
      child.stdin.end(options.stdin ?? '');
    });
  }

  async shell(command: string, signal?: AbortSignal): Promise<CommandResult> {
    return this.exec(
      ['/bin/bash', '--noprofile', '--norc', '-c', command],
      signal ? { signal } : {},
    );
  }

  stop(): void {
    this.closed = true;
    for (const pid of this.active) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        /* exited */
      }
    }
    this.active.clear();
  }
  async dispose(): Promise<void> {
    this.stop();
    await rm(this.root, { recursive: true, force: true });
  }
}
