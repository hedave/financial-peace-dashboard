import assert from 'node:assert/strict';
import { trimBill, trimBills } from '../netlify/functions/bills.mjs';

const trimmed = trimBill({
  id: 'b1',
  name: 'Power',
  amount: 120.5,
  dueDate: '2026-09-15',
  status: 'unpaid',
  paidDate: null,
  recurring: true,
  categoryId: 'secret-cat',
  notes: 'do not leak',
});
assert.equal(trimmed.id, 'b1');
assert.equal(trimmed.name, 'Power');
assert.equal(trimmed.amount, 120.5);
assert.equal(trimmed.status, 'unpaid');
assert.equal(trimmed.recurring, true);
assert.equal('categoryId' in trimmed, false);
assert.equal('notes' in trimmed, false);

const list = trimBills([
  { name: 'Rent', amount: 1000, status: 'paid', paidDate: '2026-09-01', recurring: true },
  null,
]);
assert.equal(list.length, 1);
assert.equal(list[0].status, 'paid');
assert.equal(list[0].paidDate, '2026-09-01');

console.log('test-bills-api: ok');
