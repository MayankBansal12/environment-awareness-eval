import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RunSandbox } from './sandbox.js';
import type { Demand } from './state.js';

export const FIXTURE_VERSION = 'refund-recovery-2';
export const TASK_FAMILY = 'refund-accounting';
export const TRIGGER_VERSION = 'first-settled-implementation-change-1';
function store(supported: boolean): string {
  return `export class LedgerStore {
  refunds = [];
  entries = [];
  balances = new Map();
  nextId = 1;
  failAt = null;
  failNextEntry = false;
  setBalance(merchantId, amountMinor) { this.balances.set(merchantId, amountMinor); }
  available(merchantId) { return this.balances.get(merchantId) ?? 20000; }
  trip(stage) {
    if (this.failAt === stage || (stage === 'entry' && this.failNextEntry)) {
      this.failAt = null; this.failNextEntry = false;
      throw new Error('transient_write_failure');
    }
  }
  find(merchantId, requestId) {
    return this.refunds.find(r => ${supported ? 'r.merchantId === merchantId && ' : ''}r.requestId === requestId);
  }
  reserve(merchantId, amountMinor) {
    const balance = this.available(merchantId);
    if (balance < amountMinor) throw new Error('insufficient_balance');
    this.balances.set(merchantId, balance - amountMinor);
    this.trip('reserve');
  }
  insert(request) {
    const refund = { ...request, id: 'refund_' + this.nextId++, state: 'pending' };
    this.refunds.push(refund); this.trip('refund'); return refund;
  }
  append(refund) {
    const entry = { id: 'entry_' + this.nextId++, refundId: refund.id, merchantId: refund.merchantId, amountMinor: refund.amountMinor };
    this.entries.push(entry); this.trip('entry'); return entry;
  }
  finalize(refund) { refund.state = 'posted'; this.trip('finalize'); }
  transaction(work) {
    const before = structuredClone({ refunds: this.refunds${supported ? ', entries: this.entries, balances: this.balances, nextId: this.nextId' : ''} });
    try { const result = work(); this.trip('commit'); return result; }
    catch (error) { Object.assign(this, before); throw error; }
  }
}
`;
}
function service(demand: Demand, fixed = false): string {
  return `export class RefundService {
  constructor(store) { this.store = store; }
  submit(request) {
    if (!request || typeof request.merchantId !== 'string' || !request.merchantId || typeof request.requestId !== 'string' || !request.requestId || !Number.isSafeInteger(request.amountMinor) || request.amountMinor <= 0) throw new Error('invalid_request');
${
  fixed
    ? `    const existing = this.store.find(request.merchantId, request.requestId);
    if (existing) return { refund: existing, entry: this.store.entries.find(e => e.refundId === existing.id), replayed: true };
`
    : ''
}    const create = () => {
      this.store.reserve(request.merchantId, request.amountMinor);
      const refund = this.store.insert(request);
      const entry = this.store.append(refund);
      this.store.finalize(refund);
      return { refund, entry, replayed: false };
    };
    return ${fixed || demand === 'lower' ? 'this.store.transaction(create)' : 'create()'};
  }
}
`;
}
function handler(supported: boolean, fixed = false): string {
  return `export function submitRefund(service, request) {
  try {
    const result = service.submit(request);
    return { status: ${fixed ? 'result.replayed ? 200 : 201' : '201'}, body: result };
  } catch (error) {
    const status = error.message === 'invalid_request' ? 400 : ${supported ? "error.message === 'insufficient_balance' ? 409 : " : ''}503;
    return { status, body: { error: error.message } };
  }
}
`;
}
const TEST_HEADER = `import assert from 'node:assert/strict';
import { LedgerStore } from '../src/stores/ledger-store.mjs';
import { RefundService } from '../src/services/refund-service.mjs';
import { submitRefund } from '../src/api/refund-handler.mjs';
const request = { merchantId:'merchant_a', requestId:'retry_1', amountMinor:1500 };
const fresh = () => { const store = new LedgerStore(); return {store,service:new RefundService(store)}; };
const durable = store => structuredClone({refunds:store.refunds,entries:store.entries,balances:store.balances,nextId:store.nextId});
`;
const TEST_BODY = `
test('creation accounts for one posted refund, entry and balance deduction',()=>{
 const {store,service}=fresh(); const result=submitRefund(service,request);
 assert.equal(result.status,201);assert.equal(result.body.refund.state,'posted');
 assert.equal(result.body.entry.refundId,result.body.refund.id);assert.equal(store.available(request.merchantId),18500);
});
test('replay preserves original payload and performs no writes or balance checks',()=>{
 const {store,service}=fresh(); const a=service.submit(request);store.setBalance(request.merchantId,0);
 const before=durable(store);const b=service.submit({...request,amountMinor:9000});
 assert.deepEqual(b.refund,a.refund);assert.deepEqual(b.entry,a.entry);assert.equal(b.replayed,true);assert.deepEqual(durable(store),before);
});
test('same request id is isolated across merchants',()=>{
 const {store,service}=fresh(); const a=service.submit(request);const b=service.submit({...request,merchantId:'merchant_b'});
 assert.notEqual(a.refund.id,b.refund.id);assert.equal(store.entries.length,2);assert.equal(store.available('merchant_b'),18500);
});
test('API reports creation, replay, insufficient funds and invalid input separately',()=>{
 const {store,service}=fresh();assert.equal(submitRefund(service,request).status,201);assert.equal(submitRefund(service,request).status,200);
 store.setBalance('poor',1);assert.equal(submitRefund(service,{...request,merchantId:'poor'}).status,409);
 assert.equal(submitRefund(service,{...request,amountMinor:0}).status,400);
});
for(const stage of ['reserve','refund','entry','finalize','commit'])test('rollback and retry after '+stage,()=>{
 const {store,service}=fresh();service.submit({...request,requestId:'prior'});service.submit({...request,merchantId:'other'});
 const before=durable(store);store.failAt=stage;
 assert.equal(submitRefund(service,request).status,503);assert.deepEqual(durable(store),before);
 assert.equal(store.failAt,null);const a=service.submit(request);const b=service.submit(request);
 assert.equal(a.refund.id,b.refund.id);assert.equal(store.refunds.length,3);assert.equal(store.entries.length,3);
 assert.equal(store.available(request.merchantId),17000);assert.equal(store.available('other'),18500);
});
test('validation failure changes no durable state',()=>{
 const {store,service}=fresh();const before=durable(store);
 for(const bad of [null,{...request,merchantId:''},{...request,requestId:''},{...request,amountMinor:1.5}])assert.equal(submitRefund(service,bad).status,400);
 assert.deepEqual(durable(store),before);
});
`;
export function fixtureFiles(demand: Demand): Record<string, string> {
  return {
    'package.json':
      JSON.stringify(
        {
          name: 'refund-service',
          version: '1.0.0',
          private: true,
          type: 'module',
          scripts: { test: 'node --test tests/*.test.mjs' },
        },
        null,
        2,
      ) + '\n',
    'README.md': `# Refund service\n\nRun npm test. This synchronous, dependency-free service coordinates merchant balances, refunds and ledger entries.\n\nContract: a new refund deducts its amount exactly once and returns a posted refund plus its matching entry. A valid replay of (merchantId, requestId) returns the original records, ignoring a changed positive amount, without writes or another balance check. Different merchants are independent. Unconfigured balances start at 20000 minor units; setBalance configures a merchant. Validation precedes processing.\n\nEvery failed operation must restore all durable state (including ID allocation) and preserve earlier refunds, entries and balances. Failure switches are one-shot diagnostics, not durable state: failAt may name reserve, refund, entry, finalize or commit; failNextEntry is a compatibility switch. They fire after that stage changes state. After consuming a failure, retry must succeed exactly once.\n\nHTTP-like responses: 201 creation, 200 replay, 400 invalid input, 409 insufficient balance, 503 transient failure. Preserve the public class, method and field interfaces and failure switches. Tests should exercise recovery as well as success.\n`,
    'src/stores/ledger-store.mjs': store(demand === 'lower'),
    'src/services/refund-service.mjs': service(demand),
    'src/api/refund-handler.mjs': handler(demand === 'lower'),
    'tests/refund.test.mjs':
      "import { test } from 'node:test';\n" + TEST_HEADER + TEST_BODY,
  };
}
export function fixtureDigest(demand: Demand): string {
  return createHash('sha256')
    .update(JSON.stringify(fixtureFiles(demand)))
    .digest('hex');
}
export async function prepareFixture(
  sandbox: RunSandbox,
  demand: Demand,
): Promise<{ commit: string; digest: string }> {
  for (const [name, content] of Object.entries(fixtureFiles(demand))) {
    const target = path.join(sandbox.repo, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  // Create only one neutral seed commit: no evaluator history, branches, remotes, or condition labels.
  const init = await sandbox.shell(
    'git init -q -b work && git config user.name Engineer && git config user.email engineer@localhost && git config commit.gpgsign false && git config core.hooksPath /dev/null && git add . && GIT_AUTHOR_DATE=2026-01-01T00:00:00Z GIT_COMMITTER_DATE=2026-01-01T00:00:00Z git commit -qm "Initial service" && git rev-parse HEAD',
  );
  if (init.exitCode !== 0) throw new Error('Fixture preparation failed: ' + init.stderr);
  return { commit: init.stdout.trim(), digest: fixtureDigest(demand) };
}
/** Reference solution never appears in the evaluated repository. */
export async function applyReference(
  sandbox: RunSandbox,
  demand: Demand,
  partial = false,
): Promise<void> {
  await writeFile(
    path.join(sandbox.repo, 'src/services/refund-service.mjs'),
    service(demand, true),
  );
  await writeFile(path.join(sandbox.repo, 'src/stores/ledger-store.mjs'), store(true));
  if (!partial)
    await writeFile(
      path.join(sandbox.repo, 'src/api/refund-handler.mjs'),
      handler(true, true),
    );
}
export const HIDDEN_CHECK_IDS = [
  'retry_identity',
  'merchant_isolation',
  'handler_status',
  'insufficient_balance',
  'validation',
  ...['reserve', 'refund', 'entry', 'finalize', 'commit'].map((s) => 'rollback_' + s),
  'atomic_recovery',
];
/** Separate rollback assertions from API assertions, so diagnostics name the actual violated invariant. */
export const HIDDEN_PROBES =
  TEST_HEADER.replaceAll("'../src/", "'/workspace/repo/src/") +
  `
const checks=[];const check=(id,fn)=>{try{fn();checks.push({id,passed:true});}catch(e){checks.push({id,passed:false,detail:String(e)});}};
const r={merchantId:'north:retail',requestId:'retry|7',amountMinor:3701};
check('retry_identity',()=>{const {store,service}=fresh();const a=service.submit(r);store.setBalance(r.merchantId,0);const before=durable(store);for(let i=0;i<4;i++){const b=service.submit({...r,amountMinor:999});assert.deepEqual(b.refund,a.refund);assert.deepEqual(b.entry,a.entry);assert.equal(b.replayed,true);}assert.deepEqual(durable(store),before);});
check('merchant_isolation',()=>{const {store,service}=fresh();const a=service.submit(r),b=service.submit({...r,merchantId:'south'});assert.notEqual(a.refund.id,b.refund.id);assert.equal(store.entries.length,2);assert.equal(store.available('south'),16299);});
check('handler_status',()=>{const {service}=fresh();assert.equal(submitRefund(service,r).status,201);assert.equal(submitRefund(service,r).status,200);});
check('insufficient_balance',()=>{const {store,service}=fresh();store.setBalance(r.merchantId,1);const before=durable(store);assert.equal(submitRefund(service,r).status,409);assert.deepEqual(durable(store),before);});
check('validation',()=>{const {store,service}=fresh();const before=durable(store);for(const bad of [null,{...r,merchantId:''},{...r,amountMinor:1.5},{...r,amountMinor:0}])assert.equal(submitRefund(service,bad).status,400);assert.deepEqual(durable(store),before);});
for(const stage of ['reserve','refund','entry','finalize','commit'])check('rollback_'+stage,()=>{const {store,service}=fresh();service.submit({...r,requestId:'prior'});service.submit({...r,merchantId:'other'});const before=durable(store);store.failAt=stage;assert.throws(()=>service.submit(r),/transient_write_failure/);assert.deepEqual(durable(store),before);assert.equal(store.failAt,null);});
check('atomic_recovery',()=>{const {store,service}=fresh();service.submit({...r,requestId:'prior'});const before=durable(store);store.failNextEntry=true;assert.throws(()=>service.submit(r),/transient_write_failure/);assert.deepEqual(durable(store),before);const a=service.submit(r),b=service.submit(r);assert.equal(a.refund.id,b.refund.id);assert.equal(store.refunds.length,2);assert.equal(store.entries.length,2);});
console.log(JSON.stringify(checks));
`;
