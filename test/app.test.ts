import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/app.ts';
import { handleMessage } from '../src/consumer.ts';
import { loadConfig } from '../src/config.ts';
import { MemoryDirectory } from '../src/customers.ts';
import { MemoryStore } from '../src/store.ts';

const cfg = loadConfig({ INVOICES_INTERNAL_KEY: 'secret-key' } as NodeJS.ProcessEnv);
const store = new MemoryStore();
const customers = new MemoryDirectory();
const deps = { store, customers };
let server: Server;
let base: string;

const USER = '11111111-1111-4111-a111-111111111111';
const orderId = (n: number) => `aaaaaaaa-aaaa-4aaa-aaaa-${String(n).padStart(12, '0')}`;
const placed = (n: number, total = 10825, over: object = {}) => ({
  orderId: orderId(n), userId: USER, total, currency: 'USD', placedAt: '2026-11-02T10:00:00.000Z',
  lines: [{ productId: 'p-1', quantity: 2, unitPrice: 5000 }, { productId: 'p-2', quantity: 1, unitPrice: null }], ...over,
});
const issue = (n: number, total?: number, over?: object) => handleMessage(deps, 'order.placed', JSON.stringify(placed(n, total, over)));
const call = (path: string, method = 'GET', body?: unknown, key: string | null = 'secret-key') =>
  fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(key ? { 'x-internal-key': key } : {}) }, body: body ? JSON.stringify(body) : undefined });

before(() => {
  customers.customers.set(USER, { email: 'ada@shoplab.test', fullName: 'Ada Lovelace' });
  server = createApp({ cfg, store }).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => void server.close());

test('every /invoices route needs the internal key', async () => {
  await issue(1);
  const id = store.invoices[0].id;
  for (const [path, method] of [['/invoices', 'GET'], [`/invoices/order/${orderId(1)}`, 'GET'], [`/invoices/${id}/pdf`, 'GET'], [`/invoices/${id}/credit-notes`, 'POST']]) {
    for (const key of [null, 'wrong', 'secret-ke', 'secret-keyy', '']) {
      assert.equal((await call(path, method, method === 'POST' ? { amount: 1 } : undefined, key)).status, 401, `${method} ${path} key=${key}`);
    }
  }
  assert.equal((await fetch(base + '/healthz')).status, 200); // health stays open
});

test('without a configured key nothing is accepted, not even an empty one', async () => {
  const s = createApp({ cfg: { ...cfg, internalKey: undefined }, store }).listen(0);
  try {
    const url = `http://127.0.0.1:${(s.address() as AddressInfo).port}/invoices`;
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { 'x-internal-key': '' } })).status, 401);
    assert.equal((await fetch(url, { headers: { 'x-internal-key': 'undefined' } })).status, 401);
  } finally {
    s.close();
  }
});

test('order.placed issues an invoice with a tax split and a copy of the customer', async () => {
  const res = await call(`/invoices/order/${orderId(1)}`);
  assert.equal(res.status, 200);
  const inv = (await res.json()) as Record<string, unknown>;
  assert.deepEqual(
    { ...inv, id: undefined },
    { id: undefined, number: 'INV-000001', orderId: orderId(1), customerEmail: 'ada@shoplab.test', customerName: 'Ada Lovelace', subtotal: 10000, tax: 825, total: 10825, currency: 'USD', credited: 0 },
  );
  customers.customers.set(USER, { email: 'changed@shoplab.test', fullName: 'Ada L.' });
  assert.equal(((await (await call(`/invoices/order/${orderId(1)}`)).json()) as { customerEmail: string }).customerEmail, 'ada@shoplab.test'); // snapshot, not a live join
  customers.customers.set(USER, { email: 'ada@shoplab.test', fullName: 'Ada Lovelace' });
});

test('a redelivered event does not create a second invoice', async () => {
  const before = store.invoices.length;
  await issue(1);
  await issue(1);
  assert.equal(store.invoices.length, before);
});

test('bad events are rejected and leave nothing behind', async () => {
  const n = store.invoices.length;
  await assert.rejects(handleMessage(deps, 'order.placed', 'not json'));
  await assert.rejects(issue(2, -5), /malformed/);
  await assert.rejects(issue(2, 1.5), /malformed/);
  await assert.rejects(issue(2, 100, { orderId: 'nope' }), /malformed/);
  await assert.rejects(issue(2, 100, { currency: 'JPY' }), /no tax rule/);
  await assert.rejects(issue(2, 100, { userId: '99999999-9999-4999-a999-999999999999' }), /no customer/);
  assert.equal(store.invoices.length, n);
  await handleMessage(deps, 'user.registered', '{}'); // not ours: ignored
});

test('list is newest first and paginated; unknown order is 404', async () => {
  await issue(3);
  await issue(4);
  const all = (await (await call('/invoices')).json()) as { number: string }[];
  assert.deepEqual(all.map((i) => i.number), ['INV-000003', 'INV-000002', 'INV-000001']);
  assert.deepEqual(((await (await call('/invoices?page=2&pageSize=2')).json()) as { number: string }[]).map((i) => i.number), ['INV-000001']);
  assert.equal((await call(`/invoices/order/${orderId(99)}`)).status, 404);
  assert.equal((await call('/invoices/order/not-a-uuid')).status, 404);
});

test('credit notes: partial, bounded by the total, validated', async () => {
  const id = store.invoices[0].id; // total 10825
  const post = (body: unknown) => call(`/invoices/${id}/credit-notes`, 'POST', body);
  assert.equal((await post({ amount: 0 })).status, 400);
  assert.equal((await post({ amount: 1.5 })).status, 400);
  assert.equal((await post({})).status, 400);
  assert.equal((await post({ amount: 5, reason: 5 })).status, 400);
  const first = await post({ amount: 4000, reason: 'damaged' });
  assert.equal(first.status, 201);
  assert.equal(((await first.json()) as { credited: number }).credited, 4000);
  assert.equal(store.notes.at(-1)!.tax, 305); // 825 * 4000 / 10825, rounded
  const over = await post({ amount: 6826 });
  assert.equal(over.status, 409);
  assert.deepEqual(await over.json(), { error: 'credit_exceeds_total', remaining: 6825 });
  assert.equal((await post({ amount: 6825 })).status, 201);
  assert.equal((await post({ amount: 1 })).status, 409);
  assert.equal((await call('/invoices/aaaaaaaa-aaaa-4aaa-aaaa-ffffffffffff/credit-notes', 'POST', { amount: 1 })).status, 404);
  assert.equal((await call('/invoices/nope/credit-notes', 'POST', { amount: 1 })).status, 404);
});

test('the PDF is a well-formed document with the invoice details', async () => {
  const id = store.invoices[0].id;
  const res = await call(`/invoices/${id}/pdf`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  assert.match(res.headers.get('content-disposition') ?? '', /INV-000001\.pdf/);
  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf.toString('latin1');
  assert.ok(text.startsWith('%PDF-1.4'));
  assert.ok(text.trimEnd().endsWith('%%EOF'));
  for (const s of ['Invoice INV-000001', 'Ada Lovelace', 'ada@shoplab.test', 'USD 108.25', 'Tax \\(8.25%\\)', 'credit', 'Credit note', 'p-1']) assert.ok(text.toLowerCase().includes(s.toLowerCase()), s);
  // the xref offsets must point at the objects they name
  const xref = Number(/startxref\n(\d+)/.exec(text)![1]);
  assert.ok(text.slice(xref).startsWith('xref'));
  const offsets = [...text.slice(xref).matchAll(/(\d{10}) 00000 n/g)].map((m) => Number(m[1]));
  offsets.forEach((o, i) => assert.ok(text.slice(o).startsWith(`${i + 1} 0 obj`), `object ${i + 1}`));
  assert.equal((await call('/invoices/nope/pdf')).status, 404);
});

test('a hostile name cannot break out of the PDF text', async () => {
  customers.customers.set(USER, { email: 'x@y.z', fullName: 'Eve) Tj (\\ 100 100 Td (pwned' });
  await issue(7);
  const inv = store.invoices.find((i) => i.order_id === orderId(7))!;
  const text = Buffer.from(await (await call(`/invoices/${inv.id}/pdf`)).arrayBuffer()).toString('latin1');
  assert.ok(text.includes('Eve\\) Tj \\(\\\\ 100 100 Td \\(pwned'));
});
