import { resolve } from 'node:path';
import { Pool } from 'pg';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { startConsumer } from './consumer.ts';
import { IamDirectory } from './customers.ts';
import { migrate } from './migrate.ts';
import { PgStore } from './store.ts';

const cfg = loadConfig();
if (!cfg.internalKey) throw new Error('INVOICES_INTERNAL_KEY is required');
const pool = new Pool({ connectionString: cfg.databaseUrl });
await migrate(pool, resolve(import.meta.dirname, '../migrations'));
const deps = { store: new PgStore(pool), customers: new IamDirectory(new Pool({ connectionString: cfg.iamDatabaseUrl, max: 3 })) };
if (cfg.rabbitUrl) await startConsumer(cfg.rabbitUrl, deps);
createApp({ cfg, store: deps.store }).listen(cfg.port, () => console.log(`invoices listening on ${cfg.port}`));
