import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { IamDirectory } from '../src/customers.ts';
import { issueForOrder } from '../src/invoices.ts';
import { migrate } from '../src/migrate.ts';
import { seed, seedInvoices } from '../src/seed.ts';
import { PgStore } from '../src/store.ts';

// Runs against a real, empty Postgres. CI provides TEST_DATABASE_URL; locally the tests are skipped.
const url = process.env.TEST_DATABASE_URL;
const USER = '11111111-1111-4111-a111-111111111111';

test('migrations, seed, idempotent issue, concurrency and the narrow iam role', { skip: !url }, async () => {
  const pool = new Pool({ connectionString: url });
  const reader = new URL(url!);
  reader.username = 'invoices_reader_test';
  reader.password = 'reader';
  let readerPool: Pool | undefined;
  try {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    const dir = resolve(import.meta.dirname, '../migrations');
    assert.equal((await migrate(pool, dir)).length, 3);
    assert.deepEqual(await migrate(pool, dir), []);

    const store = new PgStore(pool);
    assert.equal(await seed(store), 100);
    assert.equal(await seed(store), 0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM invoice_lines')).rows[0].n > 100, true);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM invoices WHERE subtotal + tax <> total')).rows[0].n, 0);
    const first = seedInvoices()[0];
    assert.equal((await store.getByOrder(first.orderId))?.total, first.total);

    // Stand-in for iam's database: the same users columns, read through a role that can only see three of them.
    await pool.query(`CREATE TABLE users (id uuid PRIMARY KEY, email text NOT NULL, full_name text NOT NULL, password_hash text NOT NULL, role text NOT NULL DEFAULT 'customer')`);
    await pool.query(`INSERT INTO users (id, email, full_name, password_hash) VALUES ($1, 'ada@shoplab.test', 'Ada Lovelace', 'hash')`, [USER]);
    await pool.query('DROP OWNED BY invoices_reader_test').catch(() => {});
    await pool.query('DROP ROLE IF EXISTS invoices_reader_test');
    await pool.query(`CREATE ROLE invoices_reader_test LOGIN PASSWORD 'reader'`);
    await pool.query('GRANT SELECT (id, email, full_name) ON users TO invoices_reader_test');
    await pool.query('GRANT USAGE ON SCHEMA public TO invoices_reader_test');
    readerPool = new Pool({ connectionString: reader.toString() });
    const customers = new IamDirectory(readerPool);
    assert.deepEqual(await customers.find(USER), { email: 'ada@shoplab.test', fullName: 'Ada Lovelace' });
    assert.equal(await customers.find('99999999-9999-4999-a999-999999999999'), null);
    await assert.rejects(readerPool.query('SELECT password_hash FROM users'), /permission denied/);
    await assert.rejects(readerPool.query('SELECT role FROM users'), /permission denied/);
    await assert.rejects(readerPool.query('DELETE FROM users'), /permission denied/);

    const ev = { orderId: 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb', userId: USER, total: 12000, currency: 'EUR', placedAt: '2026-11-02T10:00:00Z', lines: [{ productId: 'p-1', quantity: 1, unitPrice: 12000 }] };
    const results = await Promise.all(Array.from({ length: 8 }, () => issueForOrder({ store, customers }, ev)));
    assert.equal(results.filter((r) => r.created).length, 1);
    assert.equal(new Set(results.map((r) => r.invoice.id)).size, 1);
    const inv = results[0].invoice;
    assert.deepEqual([inv.subtotal, inv.tax, inv.total, inv.customer_email], [10000, 2000, 12000, 'ada@shoplab.test']);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM invoice_lines WHERE invoice_id = $1', [inv.id])).rows[0].n, 1);

    const notes = await Promise.all(Array.from({ length: 5 }, () => store.addCreditNote(inv.id, 5000, 'concurrent')));
    assert.deepEqual(notes.map((n) => n.result).sort(), ['exceeds', 'exceeds', 'exceeds', 'ok', 'ok']);
    const after = await store.getInvoice(inv.id);
    assert.equal(after?.credited, 10000);
    assert.equal((await store.listCreditNotes(inv.id)).length, 2);
    assert.equal(after?.tax_rate, 0.2);
  } finally {
    await readerPool?.end();
    await pool.query('DROP OWNED BY invoices_reader_test').catch(() => {});
    await pool.query('DROP ROLE IF EXISTS invoices_reader_test').catch(() => {});
    await pool.end();
  }
});
