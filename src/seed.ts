import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { loadConfig } from './config.ts';
import { migrate } from './migrate.ts';
import { PgStore, type NewInvoice, type Store } from './store.ts';
import { splitInclusive } from './tax.ts';

/** Same generator as shoplab-orders' seed, so the totals and shoppers line up. Order ids are derived, not orders' own. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const uuidFrom = (key: string) => {
  const h = createHash('sha1').update(key).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

export const seedUserId = (i: number) => uuidFrom(`shoplab-seed-user-${i}`);

export function seedInvoices(count = 100, seed = 11): NewInvoice[] {
  const rnd = mulberry32(seed);
  return Array.from({ length: count }, (_, i) => {
    const lines = Array.from({ length: 1 + Math.floor(rnd() * 3) }, (_, j) => ({
      product_id: `p-seed${String(1 + ((i * 7 + j * 13) % 200)).padStart(3, '0')}`,
      quantity: 1 + Math.floor(rnd() * 3),
      unit_price: 500 + Math.floor(rnd() * 19500) as number | null,
    }));
    const shopper = Math.floor(rnd() * 50);
    rnd(); // orders draws its final status here
    const total = lines.reduce((n, l) => n + l.quantity * (l.unit_price ?? 0), 0);
    const { subtotal, tax, rate } = splitInclusive(total, 'USD');
    return {
      orderId: uuidFrom(`shoplab-seed-order-${i + 1}`),
      userId: seedUserId(shopper),
      customerEmail: `shopper${shopper}@shoplab.test`,
      customerName: `Seed Shopper ${shopper}`,
      subtotal,
      tax,
      total,
      taxRate: rate,
      currency: 'USD',
      lines,
      issuedAt: new Date(Date.UTC(2026, 9, 1) + i * 3_600_000),
    };
  });
}

export async function seed(store: Store) {
  let created = 0;
  for (const n of seedInvoices()) if ((await store.createInvoice(n)).created) created++;
  return created;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const pool = new Pool({ connectionString: loadConfig().databaseUrl });
  await migrate(pool, resolve(import.meta.dirname, '../migrations'));
  console.log(`seeded ${await seed(new PgStore(pool))} invoices`);
  await pool.end();
}
