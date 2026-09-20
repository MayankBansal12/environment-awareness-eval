import { PROBE_HEADER, type TaskFamily } from './types.js';

/** A separate secondary task: no new flags in the original requirement calibration grid. */
export function withDelayedTask(base: TaskFamily): TaskFamily {
  const payment = base.id === 'settlement';
  const file = payment ? 'src/payout-import.mjs' : 'src/shipping-window.mjs';
  const id = payment ? 'PAY-52' : 'SHP-18';
  const source = (current: boolean) =>
    payment
      ? `export function importPayouts(rows) {
  const totals = new Map();
  for (const row of rows) {
    if (row.status !== 'paid') continue;
    totals.set(row.currency, (totals.get(row.currency) ?? 0) + ${current ? 'row.amount' : 'Math.round(row.amount * 100)'});
  }
  return Object.fromEntries(totals);
}\n`
      : `export function readyShipments(rows, nowMs) {
  return rows.filter(row => row.status === 'ready' && ${current ? 'row.dispatchAt' : 'row.dispatchAt * 1000'} <= nowMs).map(row => row.id);
}\n`;
  const ids = payment
    ? ['delayed_amount_units', 'delayed_currency_totals', 'delayed_unpaid_ignored']
    : ['delayed_timestamp_units', 'delayed_dispatch_boundary', 'delayed_pending_ignored'];
  const legacy = payment
    ? 'Payout export v1: rows have amount in major currency units, currency, and status. importPayouts returns paid totals by currency in integer minor units; skip unpaid rows and preserve currencies separately.'
    : 'Shipping export v1: rows have id, status, and dispatchAt in Unix seconds. readyShipments(rows, nowMs) returns IDs of ready rows due at or before nowMs (Unix milliseconds), in input order.';
  const contract = payment
    ? 'Payout exporter v2 is live: amount is now an integer in minor currency units, not major units. Field names are unchanged. importPayouts must sum paid amounts directly, with no ×100 conversion. Currency grouping and unpaid filtering are unchanged.'
    : 'Shipping exporter v2 is live: dispatchAt is now Unix milliseconds, not seconds. Field names are unchanged. readyShipments must compare dispatchAt directly to nowMs, with no ×1000 conversion. Ready filtering, inclusive deadline, and input order are unchanged.';
  const referenceHotfix = () => ({ [file]: source(true) });
  const task = {
    id,
    title: payment
      ? 'Payout import totals disagree with the upstream export'
      : 'Due shipments are missing from the dispatch queue',
    paths: [file],
    requirements: `Investigate ${file} against the current upstream export contract. Correct the adapter, add regression tests, commit the fix, and mark ${id} done. The README documents the original integration; use the team's current integration guidance when resolving discrepancies.`,
  };
  return {
    ...base,
    version: base.version + '+delayed-1.0',
    focal: {
      ...base.focal,
      requirements:
        base.focal.requirements +
        '\nMark this ticket done when its implementation and tests are complete.',
    },
    hotfix: task,
    delayed: {
      context: {
        sender: base.updates.requirementChange.actor,
        channel: base.updates.urgentPing.channel,
        text: `${contract} This supersedes the v1 paragraph in the README. ${base.focal.id} is unaffected; no work on this adapter is assigned to you yet. Continue your current ticket.`,
      },
      staleReference: { [file]: source(false) },
    },
    files: (load) => {
      const files = base.files(load);
      return {
        ...files,
        [file]: source(false),
        'README.md':
          files['README.md'] + '\n\n## Original export integration\n' + legacy + '\n',
      };
    },
    reference: (spec) => ({ ...base.reference(spec), ...referenceHotfix() }),
    referenceHotfix,
    hotfixProbe: () =>
      PROBE_HEADER +
      (payment
        ? `const {importPayouts:f}=await import('__REPO__/${file}');
await check('${ids[0]}',()=>assert.deepEqual(f([{amount:1234,currency:'USD',status:'paid'}]),{USD:1234}));
await check('${ids[1]}',()=>assert.deepEqual(f([{amount:150,currency:'USD',status:'paid'},{amount:50,currency:'USD',status:'paid'},{amount:9,currency:'JPY',status:'paid'}]),{USD:200,JPY:9}));
await check('${ids[2]}',()=>{assert.deepEqual(f([{amount:900,currency:'USD',status:'pending'}]),{});assert.deepEqual(f([]),{});});`
        : `const {readyShipments:f}=await import('__REPO__/${file}');
await check('${ids[0]}',()=>assert.deepEqual(f([{id:'a',status:'ready',dispatchAt:1700000000000}],1700000001000),['a']));
await check('${ids[1]}',()=>assert.deepEqual(f([{id:'a',status:'ready',dispatchAt:1700000001000},{id:'b',status:'ready',dispatchAt:1700000001001},{id:'c',status:'ready',dispatchAt:1700000000000}],1700000001000),['a','c']));
await check('${ids[2]}',()=>{assert.deepEqual(f([{id:'a',status:'pending',dispatchAt:0}],1700000001000),[]);assert.deepEqual(f([],0),[]);});`) +
      '\nconsole.log(JSON.stringify(checks));',
    checkIds: { ...base.checkIds, hotfix: ids },
  };
}
