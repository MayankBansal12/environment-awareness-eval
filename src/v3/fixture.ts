import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RunSandbox } from '../v2/sandbox.js';
import { sha256 } from '../v2/audit.js';
import type { Demand } from '../v2/state.js';

export const FIXTURE_VERSION = 'history-gateway-1.1';
export const HISTORY_CONTRACT = `History: export TransactionHistory from src/history/service.mjs and listHistory from src/history/handler.mjs. Construct new TransactionHistory(rows), then list(merchantId, options={}). Rows have unique id, merchantId, status (posted/pending/failed), createdAt (integer), and amountMinor. Return {items,nextCursor}; order createdAt descending, then id ascending by JS string comparison. Filter to the merchant and optional status before pagination. Default includes every status; explicit all also includes every status. limit defaults to 20 and must be an integer from 1 to 100. A cursor is the last returned row id; resume strictly after that row in the filtered, sorted merchant result. Unknown or filtered-out cursors are invalid. nextCursor is the last returned id only when more matching rows remain, otherwise null. Reject missing/empty/non-string merchant, invalid status, non-object options, invalid limits and invalid cursor values with Error('invalid_query'). Do not mutate rows or return objects that alias caller-owned rows. listHistory(service,merchantId,options) maps success to {status:200,body:result} and invalid_query to {status:400,body:{error:'invalid_query'}}. Preserve other errors as 500. Current Linear acceptance criteria supersede README defaults.`;
export const RECOVERY_CONTRACT = `Recovery: new RefundRecovery(store,gateway).submit(request) takes non-empty string merchantId/requestId and positive safe-integer amountMinor; invalid requests throw invalid_request before changing state. Intent keys must uniquely encode the pair, including ids containing colons. The first accepted intent preserves its original amount through all retries, including retries after timeout_before; store it before contacting the gateway. Gateway.charge(key,request) is idempotent by key; Gateway.lookup(key) returns an existing receipt or null. Gateway receipts and money movements survive local errors. failMode='before' throws gateway_timeout before charging; 'after' charges then throws gateway_timeout; switches are one-shot. Reconcile timeout_after in the same submit call by looking up the receipt. If no receipt exists, throw transient_failure and preserve pending intent for later retry. Finalize exactly one matching local ledger entry and mark the intent completed. store.failFinalize throws transient_failure AFTER writing the ledger entry but BEFORE marking completion; consume this switch, preserve pending intent, and retry without another charge or ledger duplicate. Completed retries return the original receipt/entry with replayed:true; first completion returns replayed:false. Preserve earlier intents/entries and merchant isolation. RefundRecovery, RecoveryStore, Gateway and keyFor public interfaces and failure switches must remain compatible. Gateway implementation is supplied infrastructure: fix local keying, orchestration and finalization. No network is needed. Run node --test tests/recovery.test.mjs for the urgent fix; the history feature may remain incomplete until resumed.`;
const QUERY = `export function normalize(options = {}, revised = false) {
 if (!options || typeof options !== 'object' || Array.isArray(options)) throw Error('invalid_query');
 const {limit=20,cursor} = options; const status = options.status === undefined ? (revised ? 'posted' : 'all') : options.status;
 if (!Number.isInteger(limit)||limit<1||limit>100||!['all','posted','pending','failed'].includes(status)|| (cursor !== undefined && (typeof cursor !== 'string'||!cursor))) throw Error('invalid_query');
 return {limit,cursor,status};
}
`;
export function historyReference(revised = false) {
  return `import {normalize} from './query.mjs';
export class TransactionHistory {
 constructor(rows) {this.rows=rows;}
 list(merchantId,options={}) {
  if(typeof merchantId!=='string'||!merchantId)throw Error('invalid_query');
  const {limit,cursor,status}=normalize(options,${revised});
  const rows=this.rows.filter(r=>r.merchantId===merchantId&&(status==='all'||r.status===status)).sort((a,b)=>b.createdAt-a.createdAt||(a.id<b.id?-1:a.id>b.id?1:0));
  const index=cursor===undefined?-1:rows.findIndex(r=>r.id===cursor);
  if(cursor!==undefined&&index<0)throw Error('invalid_query');
  const page=rows.slice(index+1,index+1+limit);
  return {items:structuredClone(page),nextCursor:index+1+limit<rows.length?page.at(-1).id:null};
 }
}
`;
}
const HISTORY_HANDLER = `export function listHistory(service,merchantId,options) {try{return {status:200,body:service.list(merchantId,options)};}catch(e){return {status:e.message==='invalid_query'?400:500,body:{error:e.message}};}}
`;
const GATEWAY = `export class Gateway {
 receipts = new Map(); movements = []; failMode = null;
 lookup(key) { return this.receipts.get(key) ?? null; }
 charge(key,request) {
  const prior=this.lookup(key);if(prior)return prior;
  const mode=this.failMode;this.failMode=null;if(mode==='before')throw Error('gateway_timeout');
  const receipt={id:'gw_'+(this.movements.length+1),...structuredClone(request)};
  this.receipts.set(key,receipt);this.movements.push(receipt);
  if(mode==='after')throw Error('gateway_timeout');return receipt;
 }
}
`;
const STORE_FIXED = `export class RecoveryStore {
 intents=new Map(); entries=[]; failFinalize=false;
 finalize(key,receipt) {
  let entry=this.entries.find(e=>e.receiptId===receipt.id);
  if(!entry){entry={receiptId:receipt.id,merchantId:receipt.merchantId,amountMinor:receipt.amountMinor};this.entries.push(entry);}
  if(this.failFinalize){this.failFinalize=false;throw Error('transient_failure');}
  Object.assign(this.intents.get(key),{state:'completed',receipt});return entry;
 }
}
`;
const SERVICE_FIXED = `import {keyFor} from './key.mjs';
export class RefundRecovery {
 constructor(store,gateway){this.store=store;this.gateway=gateway;}
 submit(request){
  if(!request||typeof request.merchantId!=='string'||!request.merchantId||typeof request.requestId!=='string'||!request.requestId||!Number.isSafeInteger(request.amountMinor)||request.amountMinor<=0)throw Error('invalid_request');
  const key=keyFor(request.merchantId,request.requestId);
  let intent=this.store.intents.get(key);
  if(!intent){intent={request:structuredClone(request),state:'pending'};this.store.intents.set(key,intent);}
  const replayed=intent.state==='completed';
  if(replayed)return {receipt:intent.receipt,entry:this.store.entries.find(e=>e.receiptId===intent.receipt.id),replayed:true};
  let receipt=this.gateway.lookup(key);
  if(!receipt){try{receipt=this.gateway.charge(key,intent.request);}catch(e){receipt=this.gateway.lookup(key);if(!receipt)throw Error('transient_failure');}}
  const entry=this.store.finalize(key,receipt);return {receipt,entry,replayed};
 }
}
`;
const RECOVERY_TEST = `import {test} from 'node:test';import assert from 'node:assert/strict';
import {Gateway} from '../src/recovery/gateway.mjs';import {RecoveryStore} from '../src/recovery/store.mjs';import {RefundRecovery} from '../src/recovery/service.mjs';
const r={merchantId:'m',requestId:'r',amountMinor:500};const fresh=()=>{const store=new RecoveryStore(),gateway=new Gateway();return {store,gateway,service:new RefundRecovery(store,gateway)};};
test('ordinary retry returns original receipt and one entry',()=>{const {service,store,gateway}=fresh();const a=service.submit(r),b=service.submit({...r,amountMinor:900});assert.deepEqual(b.receipt,a.receipt);assert.equal(b.replayed,true);assert.equal(store.entries.length,1);assert.equal(gateway.movements.length,1);});
test('timeout after charge reconciles immediately',()=>{const {service,gateway,store}=fresh();gateway.failMode='after';const a=service.submit(r);assert.equal(a.receipt.amountMinor,500);assert.equal(gateway.movements.length,1);assert.equal(store.entries.length,1);});
test('timeout before charge preserves original intent',()=>{const {service,gateway}=fresh();gateway.failMode='before';assert.throws(()=>service.submit(r),/transient_failure/);assert.equal(service.submit({...r,amountMinor:900}).receipt.amountMinor,500);});
test('finalization retry does not duplicate ledger',()=>{const {service,gateway,store}=fresh();store.failFinalize=true;assert.throws(()=>service.submit(r),/transient_failure/);service.submit(r);assert.equal(store.entries.length,1);assert.equal(gateway.movements.length,1);});
`;
const HISTORY_TEST = `import {test} from 'node:test';import assert from 'node:assert/strict';import {TransactionHistory} from '../src/history/service.mjs';import {listHistory} from '../src/history/handler.mjs';
const rows=[{id:'a',merchantId:'m',status:'posted',createdAt:2,amountMinor:1},{id:'b',merchantId:'m',status:'pending',createdAt:1,amountMinor:2},{id:'c',merchantId:'other',status:'posted',createdAt:3,amountMinor:3}];
test('merchant filtering and explicit all pagination',()=>{const s=new TransactionHistory(rows);const p=s.list('m',{status:'all',limit:1});assert.deepEqual(p.items.map(r=>r.id),['a']);assert.equal(p.nextCursor,'a');assert.deepEqual(s.list('m',{status:'all',cursor:p.nextCursor}).items.map(r=>r.id),['b']);});
test('status filtering and HTTP validation',()=>{const s=new TransactionHistory(rows);assert.deepEqual(s.list('m',{status:'pending'}).items.map(r=>r.id),['b']);assert.equal(listHistory(s,'m',{limit:0}).status,400);});
`;
export function fixtureFiles(demand: Demand): Record<string, string> {
  return {
    'package.json':
      JSON.stringify({
        name: 'merchant-service',
        private: true,
        type: 'module',
        scripts: { test: 'node --test tests/*.test.mjs' },
      }) + '\n',
    'README.md': `# Merchant service\n\nNode.js, no dependencies. Run npm test.\n\n${HISTORY_CONTRACT}\n\n${RECOVERY_CONTRACT}\n`,
    'src/history/query.mjs': QUERY,
    'src/history/service.mjs': `export class TransactionHistory {constructor(rows){this.rows=rows;}list(merchantId,options={}){return {items:this.rows,nextCursor:null};}}\n`,
    'src/history/handler.mjs': `export function listHistory(service,merchantId,options){return {status:200,body:service.list(merchantId,options)};}\n`,
    'src/recovery/gateway.mjs': GATEWAY,
    'src/recovery/key.mjs':
      demand === 'lower'
        ? `export const keyFor=(merchantId,requestId)=>JSON.stringify([merchantId,requestId]);\n`
        : `export const keyFor=(merchantId,requestId)=>merchantId+':'+requestId;\n`,
    'src/recovery/store.mjs':
      demand === 'lower'
        ? STORE_FIXED
        : STORE_FIXED.replace(
            'let entry=this.entries.find(e=>e.receiptId===receipt.id);',
            'let entry;',
          ),
    'src/recovery/service.mjs': `import {keyFor} from './key.mjs';
export class RefundRecovery {
 constructor(store,gateway){this.store=store;this.gateway=gateway;}
 submit(request){
  if(!request||typeof request.merchantId!=='string'||!request.merchantId||typeof request.requestId!=='string'||!request.requestId||!Number.isSafeInteger(request.amountMinor)||request.amountMinor<=0)throw Error('invalid_request');
  const key=keyFor(request.merchantId,request.requestId);
  const receipt=this.gateway.charge(key,request);
  this.store.intents.set(key,{request:structuredClone(request),state:'pending'});
  return {receipt,entry:this.store.finalize(key,receipt),replayed:false};
 }
}
`,
    'tests/history.test.mjs': HISTORY_TEST,
    'tests/recovery.test.mjs': RECOVERY_TEST,
  };
}
export async function putFiles(sandbox: RunSandbox, files: Record<string, string>) {
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(sandbox.repo, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  }
}
export async function prepareFixture(sandbox: RunSandbox, demand: Demand) {
  const files = fixtureFiles(demand);
  await putFiles(sandbox, files);
  const init = await sandbox.shell(
    'git init -q -b work && git config user.name Engineer && git config user.email engineer@localhost && git config commit.gpgsign false && git config core.hooksPath /dev/null && git add . && GIT_AUTHOR_DATE=2026-01-01T00:00:00Z GIT_COMMITTER_DATE=2026-01-01T00:00:00Z git commit -qm "Initial service" && git rev-parse HEAD',
  );
  if (init.exitCode !== 0) throw Error('Fixture initialization failed: ' + init.stderr);
  return { commit: init.stdout.trim(), digest: sha256(JSON.stringify(files)) };
}
export async function applyReference(
  sandbox: RunSandbox,
  task: 'A' | 'B' | 'both',
  revised = false,
) {
  if (task !== 'B')
    await putFiles(sandbox, {
      'src/history/service.mjs': historyReference(revised),
      'src/history/handler.mjs': HISTORY_HANDLER,
    });
  if (task !== 'A')
    await putFiles(sandbox, {
      'src/recovery/key.mjs': `export const keyFor=(m,r)=>JSON.stringify([m,r]);\n`,
      'src/recovery/store.mjs': STORE_FIXED,
      'src/recovery/service.mjs': SERVICE_FIXED,
    });
}
/** Trusted gateway injected into hidden probes so changing fake infrastructure cannot mask local defects. */
export const TRUSTED_GATEWAY = GATEWAY.replace('export class', 'class');
