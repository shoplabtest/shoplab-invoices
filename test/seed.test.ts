import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seedInvoices, seedUserId } from '../src/seed.ts';
import { SEED_PEOPLE } from '../src/seedPeople.ts';
import { MemoryStore } from '../src/store.ts';
import { seed } from '../src/seed.ts';

test('seed invoices belong to the people iam seeds, under the same ids', () => {
  const byId = new Map(SEED_PEOPLE.map(([email, name], i) => [seedUserId(i), { email, name }]));
  assert.equal(byId.size, 50);
  for (const inv of seedInvoices()) {
    const person = byId.get(inv.userId);
    assert.ok(person, `unknown seed user ${inv.userId}`);
    assert.equal(inv.customerEmail, person.email);
    assert.equal(inv.customerName, person.name);
  }
  assert.equal(seedUserId(0), '78db596d-05c1-4f55-a5ff-eb4939d742a0');
  assert.equal(SEED_PEOPLE[0][0], 'grace.rossi.0@shoplab.test');
});

test('the seed is deterministic and idempotent', async () => {
  assert.deepEqual(seedInvoices(), seedInvoices());
  const store = new MemoryStore();
  assert.equal(await seed(store), 100);
  assert.equal(await seed(store), 0);
  assert.ok((await store.list({ page: 1, pageSize: 200 })).every((i) => i.subtotal + i.tax === i.total));
});
