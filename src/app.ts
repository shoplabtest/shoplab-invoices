import { createHash, timingSafeEqual } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { Config } from './config.ts';
import { invoiceNumber, renderInvoicePdf } from './pdf.ts';
import type { InvoiceRow, Store } from './store.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Invoice schema from shoplab-contracts openapi/invoices.yaml, plus the human number and the credited amount. */
export const toInvoice = (i: InvoiceRow) => ({
  id: i.id,
  number: invoiceNumber(i.number),
  orderId: i.order_id,
  customerEmail: i.customer_email,
  customerName: i.customer_name,
  subtotal: i.subtotal,
  tax: i.tax,
  total: i.total,
  currency: i.currency,
  credited: i.credited,
});

const digest = (s: string) => createHash('sha256').update(s).digest();

export interface Deps { cfg: Config; store: Store }

export function createApp({ cfg, store }: Deps) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  app.get('/healthz', (_req, res) => void res.json({ ok: true }));

  /** Everything under /invoices is internal: the caller must present the shared key the gateway adds. */
  const internal = (req: Request, res: Response, next: NextFunction) => {
    const given = req.header('x-internal-key');
    if (!cfg.internalKey || !given || !timingSafeEqual(digest(given), digest(cfg.internalKey))) {
      return void res.status(401).json({ error: 'unauthorized' });
    }
    next();
  };
  app.use('/invoices', internal);

  app.get('/invoices', async (req, res) => {
    const page = Math.max(1, Number(req.query.page ?? 1) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize ?? 50) || 50));
    res.json((await store.list({ page, pageSize })).map(toInvoice));
  });

  app.get('/invoices/order/:orderId', async (req, res) => {
    const inv = UUID.test(req.params.orderId) ? await store.getByOrder(req.params.orderId) : null;
    if (!inv) return void res.status(404).json({ error: 'not_found' });
    res.json(toInvoice(inv));
  });

  app.get('/invoices/:id/pdf', async (req, res) => {
    const inv = UUID.test(req.params.id) ? await store.getInvoice(req.params.id) : null;
    if (!inv) return void res.status(404).json({ error: 'not_found' });
    const pdf = renderInvoicePdf(inv, await store.getLines(inv.id), await store.listCreditNotes(inv.id));
    res.type('application/pdf').setHeader('content-disposition', `inline; filename="${invoiceNumber(inv.number)}.pdf"`);
    res.send(pdf);
  });

  app.post('/invoices/:id/credit-notes', async (req, res) => {
    const { amount, reason } = req.body ?? {};
    if (!Number.isInteger(amount) || amount < 1) return void res.status(400).json({ error: 'invalid_request', field: 'amount' });
    if (reason !== undefined && (typeof reason !== 'string' || reason.length > 200)) return void res.status(400).json({ error: 'invalid_request', field: 'reason' });
    if (!UUID.test(req.params.id)) return void res.status(404).json({ error: 'not_found' });
    const r = await store.addCreditNote(req.params.id, amount, reason ?? null);
    if (r.result === 'not_found') return void res.status(404).json({ error: 'not_found' });
    if (r.result === 'exceeds') return void res.status(409).json({ error: 'credit_exceeds_total', remaining: r.remaining });
    res.status(201).json(toInvoice(r.invoice));
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if ((err as { type?: string }).type === 'entity.parse.failed') return void res.status(400).json({ error: 'invalid_request' });
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}
