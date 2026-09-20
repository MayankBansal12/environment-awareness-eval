import { Type, type TSchema } from 'typebox';
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { RunSandbox } from './sandbox.js';

/** Simulated team services that handle every non-repository tool. */
export interface TeamService {
  invoke(name: string, args: Record<string, unknown>): { value: unknown };
}

export interface ToolObservation {
  id: string;
  name: string;
  args: Record<string, unknown>;
  value: unknown;
  isError: boolean;
  /** Team-service result, when the tool was not a repository tool. */
  effect?: unknown;
}
const FS_DRIVER = `
import fs from 'node:fs/promises'; import path from 'node:path';
const {name,args}=JSON.parse(process.argv[1]);
const p=path.resolve('/workspace/repo',args.path||'.');
if(p!=='/workspace/repo'&&!p.startsWith('/workspace/repo/'))throw Error('Path is outside the repository');
if(name==='read') { const lines=(await fs.readFile(p,'utf8')).split('\\n'); const start=Math.max(0,(args.offset||1)-1); console.log(lines.slice(start,start+(args.limit||300)).join('\\n')); }
else if(name==='write') { await fs.mkdir(path.dirname(p),{recursive:true}); await fs.writeFile(p,args.content); console.log('File written.'); }
else if(name==='edit') { const text=await fs.readFile(p,'utf8'); if(!args.oldText||text.split(args.oldText).length!==2)throw Error('oldText must match exactly once'); await fs.writeFile(p,text.replace(args.oldText,args.newText)); console.log('File edited.'); }
else if(name==='ls') { console.log((await fs.readdir(p,{withFileTypes:true})).map(e=>e.name+(e.isDirectory()?'/':'')).sort().join('\\n')); }
else {
 let visited=0; const found=[]; const pattern=name==='grep'?new RegExp(args.pattern):null;
 async function walk(dir){ for(const e of await fs.readdir(dir,{withFileTypes:true})){if(++visited>5000)throw Error('Search limit reached');if(['.git','node_modules'].includes(e.name))continue; const file=path.join(dir,e.name);if(e.isDirectory())await walk(file);else if(e.isFile()){
 const rel=path.relative('/workspace/repo',file);
 if(name==='find'){ if(!args.pattern||rel.includes(args.pattern))found.push(rel); }
 else if((await fs.stat(file)).size<1000000){const lines=(await fs.readFile(file,'utf8')).split('\\n');lines.forEach((line,i)=>{if(pattern.test(line)&&found.length<300)found.push(rel+':'+(i+1)+':'+line);});}
 }} }
 const st=await fs.stat(p); if(st.isDirectory())await walk(p);else{const lines=(await fs.readFile(p,'utf8')).split('\\n');lines.forEach((line,i)=>{if(pattern?.test(line))found.push(path.relative('/workspace/repo',p)+':'+(i+1)+':'+line);});}
 console.log(found.slice(0,300).join('\\n'));
}
`;

export class ControlledTools {
  private cache = new Map<
    string,
    { signature: string; promise: Promise<ToolObservation> }
  >();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(
    readonly sandbox: RunSandbox,
    readonly state: TeamService,
    private observe: (observation: ToolObservation) => void,
  ) {}

  run(
    id: string,
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolObservation> {
    const signature = JSON.stringify({ name, args });
    const prior = this.cache.get(id);
    if (prior) {
      if (prior.signature !== signature)
        return Promise.reject(
          new Error('Tool request ID was reused with different arguments'),
        );
      return prior.promise;
    }
    const promise = this.queue.then(async () => {
      let value: unknown, effect: { value: unknown } | undefined;
      let isError = false;
      try {
        if (signal?.aborted) throw new Error('Tool execution aborted');
        if (['read', 'write', 'edit', 'grep', 'find', 'ls'].includes(name)) {
          const output = await this.sandbox.exec(
            [
              'node',
              '--input-type=module',
              '-e',
              FS_DRIVER,
              JSON.stringify({ name, args }),
            ],
            signal ? { signal } : {},
          );
          value = output;
          isError = output.exitCode !== 0;
        } else if (name === 'bash') {
          if (typeof args['command'] !== 'string')
            throw new Error('command must be a string');
          const output = await this.sandbox.shell(args['command'], signal);
          value = output;
          isError = output.exitCode !== 0;
        } else {
          effect = this.state.invoke(name, args);
          value = effect.value;
        }
      } catch (error) {
        isError = true;
        value = { error: error instanceof Error ? error.message : String(error) };
      }
      const observation: ToolObservation = {
        id,
        name,
        args: structuredClone(args),
        value,
        isError,
        ...(effect ? { effect } : {}),
      };
      this.observe(observation);
      return observation;
    });
    this.queue = promise.catch(() => {});
    this.cache.set(id, { signature, promise });
    return promise;
  }

  /** Wait for cancelled/in-flight commands before the evaluator probes the repo. */
  async idle(): Promise<void> {
    await this.queue;
  }

  definitions(): ToolDefinition[] {
    const descriptions: Array<{ name: string; description: string; parameters: TSchema }> =
      [
        {
          name: 'read',
          description:
            'Read a UTF-8 repository file. offset is a 1-based line number; limit defaults to 300 lines.',
          parameters: Type.Object({
            path: Type.String(),
            offset: Type.Optional(Type.Integer({ minimum: 1 })),
            limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
          }),
        },
        {
          name: 'write',
          description: 'Create or replace a repository file with the supplied content.',
          parameters: Type.Object({ path: Type.String(), content: Type.String() }),
        },
        {
          name: 'edit',
          description: 'Replace one exact occurrence of oldText in a repository file.',
          parameters: Type.Object({
            path: Type.String(),
            oldText: Type.String(),
            newText: Type.String(),
          }),
        },
        {
          name: 'grep',
          description:
            'Search repository file contents with a regular expression. Skips .git and node_modules.',
          parameters: Type.Object({
            pattern: Type.String(),
            path: Type.Optional(Type.String()),
          }),
        },
        {
          name: 'find',
          description: 'Find repository files whose relative path contains pattern.',
          parameters: Type.Object({
            pattern: Type.Optional(Type.String()),
            path: Type.Optional(Type.String()),
          }),
        },
        {
          name: 'ls',
          description: 'List a repository directory.',
          parameters: Type.Object({ path: Type.Optional(Type.String()) }),
        },
        {
          name: 'bash',
          description:
            'Execute a shell command in /workspace/repo. Network is unavailable. Commands have a 30-second limit and bounded output; processes end when the command exits.',
          parameters: Type.Object({ command: Type.String() }),
        },
      ];
    return descriptions.map(
      (d) =>
        defineTool({
          ...d,
          label: d.name,
          execute: async (id, params, signal) => {
            const observation = await this.run(
              id,
              d.name,
              params as Record<string, unknown>,
              signal,
            );
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(observation.value) }],
              details: { isError: observation.isError },
            };
          },
        }) as ToolDefinition,
    );
  }
}
