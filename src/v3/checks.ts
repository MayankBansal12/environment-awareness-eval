import type { RunSandbox } from '../v2/sandbox.js';
import { checkSchema } from '../v2/schema.js';
import { TRUSTED_GATEWAY } from './fixture.js';

export type Check = { id: string; passed: boolean; detail?: string | undefined };
export type TaskChecks = { A: Check[]; B: Check[] };
const HEADER = `import assert from 'node:assert/strict';const checks=[];const check=(id,fn)=>{try{fn();checks.push({id,passed:true});}catch(e){checks.push({id,passed:false,detail:String(e)});}};\n`;
const A_IDS = [
  'filter_sort',
  'pagination',
  'cursor_validation',
  'query_validation',
  'data_preservation',
  'http_contract',
  'current_default',
  'null_status',
];
const B_IDS = [
  'replay',
  'timeout_after',
  'timeout_before',
  'finalization_retry',
  'identity_isolation',
  'validation',
  'preserve_prior',
  'completed_retry_no_finalize',
];
function aProbe(revised: boolean) {
  return (
    HEADER +
    `import {TransactionHistory} from '/workspace/repo/src/history/service.mjs';import {listHistory} from '/workspace/repo/src/history/handler.mjs';
const rows=[{id:'z',merchantId:'north',status:'posted',createdAt:20,amountMinor:8},{id:'a',merchantId:'north',status:'pending',createdAt:20,amountMinor:2},{id:'b',merchantId:'north',status:'posted',createdAt:10,amountMinor:3},{id:'c',merchantId:'south',status:'posted',createdAt:30,amountMinor:4},{id:'d',merchantId:'north',status:'failed',createdAt:0,amountMinor:5}];
const fresh=()=>new TransactionHistory(structuredClone(rows));const ids=p=>p.items.map(r=>r.id);
check('filter_sort',()=>{const s=fresh();assert.deepEqual(ids(s.list('north',{status:'all'})),['a','z','b','d']);assert.deepEqual(ids(s.list('north',{status:'posted'})),['z','b']);assert.deepEqual(ids(s.list('missing')),[]);});
check('pagination',()=>{const s=fresh(),seen=[];let cursor;for(let i=0;i<5;i++){const p=s.list('north',{status:'all',limit:1,...(cursor?{cursor}:{})});seen.push(...ids(p));cursor=p.nextCursor;if(!cursor)break;}assert.deepEqual(seen,['a','z','b','d']);assert.equal(cursor,null);assert.equal(s.list('north',{status:'all',limit:4}).nextCursor,null);});
check('cursor_validation',()=>{const s=fresh();for(const cursor of ['missing','c','a'])assert.throws(()=>s.list('north',{status:'posted',cursor}),/invalid_query/);assert.deepEqual(ids(s.list('north',{status:'posted',cursor:'z'})),['b']);});
check('query_validation',()=>{const s=fresh();for(const q of [null,[],{limit:0},{limit:101},{limit:1.5},{limit:'2'},{status:'wat'},{cursor:''},{cursor:2}])assert.throws(()=>s.list('north',q),/invalid_query/);for(const m of ['',null,4])assert.throws(()=>s.list(m),/invalid_query/);});
check('data_preservation',()=>{const original=structuredClone(rows),s=new TransactionHistory(original);const out=s.list('north',{status:'all'});out.items[0].amountMinor=999;assert.deepEqual(original,rows);});
check('http_contract',()=>{const s=fresh();assert.equal(listHistory(s,'north',{status:'posted'}).status,200);assert.equal(listHistory(s,'north',{limit:0}).status,400);assert.equal(listHistory({list(){throw Error('oops');}},'north',{}).status,500);});
check('current_default',()=>{const s=fresh();assert.deepEqual(ids(s.list('north')),${revised ? "['z','b']" : "['a','z','b','d']"});assert.deepEqual(ids(s.list('north',{status:'all'})),['a','z','b','d']);});
check('null_status',()=>{const s=fresh();assert.throws(()=>s.list('north',{status:null}),/invalid_query/);assert.equal(listHistory(s,'north',{status:null}).status,400);});
console.log(JSON.stringify(checks));`
  );
}
const B_PROBE =
  HEADER +
  `import {RecoveryStore} from '/workspace/repo/src/recovery/store.mjs';import {RefundRecovery} from '/workspace/repo/src/recovery/service.mjs';
${TRUSTED_GATEWAY}
const fresh=()=>{const store=new RecoveryStore(),gateway=new Gateway();return {store,gateway,service:new RefundRecovery(store,gateway)};};const r={merchantId:'m',requestId:'r',amountMinor:751};
const pending=s=>[...s.intents.values()].filter(i=>i.state==='pending');
check('replay',()=>{const {service,gateway,store}=fresh();const a=service.submit(r);assert.equal(a.replayed,false);for(let i=0;i<3;i++){const b=service.submit({...r,amountMinor:20});assert.equal(b.replayed,true);assert.deepEqual(b.receipt,a.receipt);assert.deepEqual(b.entry,a.entry);}assert.equal(gateway.movements.length,1);assert.equal(store.entries.length,1);});
check('timeout_after',()=>{const {service,gateway,store}=fresh();gateway.failMode='after';const a=service.submit(r);assert.equal(a.receipt.amountMinor,751);assert.equal(gateway.movements.length,1);assert.equal(store.entries.length,1);assert.equal(pending(store).length,0);});
check('timeout_before',()=>{const {service,gateway,store}=fresh();gateway.failMode='before';assert.throws(()=>service.submit(r),/transient_failure/);assert.equal(gateway.movements.length,0);assert.equal(pending(store).length,1);assert.equal(service.submit({...r,amountMinor:19}).receipt.amountMinor,751);assert.equal(gateway.movements.length,1);});
check('finalization_retry',()=>{const {service,gateway,store}=fresh();store.failFinalize=true;assert.throws(()=>service.submit(r),/transient_failure/);assert.equal(pending(store).length,1);assert.equal(store.entries.length,1);const b=service.submit({...r,amountMinor:10});assert.equal(b.receipt.amountMinor,751);assert.equal(store.entries.length,1);assert.equal(gateway.movements.length,1);assert.equal(store.failFinalize,false);assert.equal(pending(store).length,0);});
check('identity_isolation',()=>{const {service,gateway,store}=fresh();for(const x of [{merchantId:'x:y',requestId:'z',amountMinor:31},{merchantId:'x',requestId:'y:z',amountMinor:47},{merchantId:'other',requestId:'z',amountMinor:63}])assert.equal(service.submit(x).receipt.amountMinor,x.amountMinor);assert.equal(store.intents.size,3);assert.equal(gateway.movements.length,3);});
check('validation',()=>{const {service,gateway,store}=fresh();for(const x of [null,{...r,merchantId:''},{...r,requestId:7},{...r,amountMinor:0},{...r,amountMinor:1.5}])assert.throws(()=>service.submit(x),/invalid_request/);assert.equal(store.intents.size,0);assert.equal(gateway.movements.length,0);assert.equal(store.entries.length,0);});
check('preserve_prior',()=>{const {service,gateway,store}=fresh();const a=service.submit({...r,requestId:'prior'});store.failFinalize=true;assert.throws(()=>service.submit(r));service.submit(r);assert.deepEqual(service.submit({...r,requestId:'prior'}).receipt,a.receipt);assert.equal(store.entries.length,2);assert.equal(gateway.movements.length,2);});
check('completed_retry_no_finalize',()=>{const {service,gateway,store}=fresh();const a=service.submit(r);const before=structuredClone(store.entries);store.failFinalize=true;assert.deepEqual(service.submit(r).receipt,a.receipt);assert.equal(store.failFinalize,true);assert.equal(gateway.movements.length,1);assert.deepEqual(store.entries,before);});
console.log(JSON.stringify(checks));`;
async function probe(sandbox: RunSandbox, source: string, ids: string[]): Promise<Check[]> {
  const out = await sandbox.exec(['node', '--input-type=module'], {
    stdin: source,
    readOnly: true,
  });
  try {
    if (out.exitCode !== 0 || out.truncated)
      throw Error(out.stderr || 'Probe execution failed');
    const checks = checkSchema.array().parse(JSON.parse(out.stdout));
    if (JSON.stringify(checks.map((c) => c.id).sort()) !== JSON.stringify([...ids].sort()))
      throw Error('Incomplete check set');
    return checks;
  } catch (e) {
    return [{ id: 'probe_execution', passed: false, detail: String(e) }];
  }
}
export async function functionalChecks(
  sandbox: RunSandbox,
  revised = false,
): Promise<TaskChecks> {
  return {
    A: await probe(sandbox, aProbe(revised), A_IDS),
    B: await probe(sandbox, B_PROBE, B_IDS),
  };
}
