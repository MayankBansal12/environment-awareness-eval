import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AuditLog } from '../src/audit.mjs';
import { Stock } from '../src/stock.mjs';

test('recorded entries cannot be changed by the caller', () => {
  const log = new AuditLog();
  const entry = { type: 'reserved', reservationId: 'res_1', at: 1 };
  log.record(entry);
  entry.type = 'released';
  const entries = log.entries();
  entries[0].at = 999;
  entries.push({ type: 'x' });
  entries.length = 0;
  assert.deepEqual(log.entries(), [{ type: 'reserved', reservationId: 'res_1', at: 1 }]);
});

test('Stock copies levels and defaults held to 0', () => {
  const input = [{ warehouse: 'w1', sku: 's', onHand: 3, priority: 1 }];
  const stock = new Stock(input);
  stock.level('s', 'w1').held = 2;
  assert.equal(input[0].held, undefined);
  assert.equal(new Stock([{ ...input[0], held: undefined }]).level('s', 'w1').held, 0);
});
