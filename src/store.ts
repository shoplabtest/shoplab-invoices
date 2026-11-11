import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

export interface InvoiceRow {
  id: string;
  number: number;
  order_id: string;
  user_id: string;
  customer_email: string;
  customer_name: string;
  subtotal: number;
  tax: number;
  total: number;
  tax_rate: number;
  currency: string;
  credited: number;
  issued_at: Date;
}

export interface LineRow { product_id: string; quantity: number; unit_price: number | null }
export interface CreditNoteRow { id: string; invoice_id: string; amount: number; tax: number; reason: string | null; created_at: Date }

export interface NewInvoice {
  orderId: string;
  userId: string;
  customerEmail: string;
  customerName: string;
  subtotal: number;
  tax: number;
  total: number;
  taxRate: number;
  currency: string;
  lines: LineRow[];
  issuedAt?: Date;
}

export type CreditResult =
  | { result: 'ok'; invoice: InvoiceRow; note: CreditNoteRow }
  | { result: 'not_found' }
  | { result: 'exceeds'; remaining: number };

export interface Store {
  /** Idempotent on the order id: a second call returns the existing invoice with `created: false`. */
  createInvoice(n: NewInvoice): Promise<{ invoice: InvoiceRow; created: boolean }>;
  getInvoice(id: string): Promise<InvoiceRow | null>;
  getByOrder(orderId: string): Promise<InvoiceRow | null>;
  list(o: { page: number; pageSize: number }): Promise<InvoiceRow[]>;
  getLines(invoiceId: string): Promise<LineRow[]>;
  listCreditNotes(invoiceId: string): Promise<CreditNoteRow[]>;
  /** Locks the invoice, so concurrent credit notes can never add up to more than the total. */
  addCreditNote(invoiceId: string, amount: number, reason: string | null): Promise<CreditResult>;
}

const toInvoice = (r: InvoiceRow): InvoiceRow => ({ ...r, tax_rate: Number(r.tax_rate) });
/** Tax carried by a credit note: the invoice's tax in proportion to the amount credited. */
export const creditTax = (inv: Pick<InvoiceRow, 'tax' | 'total'>, amount: number) => (inv.total === 0 ? 0 : Math.round((amount * inv.tax) / inv.total));

export class PgStore implements Store {
  constructor(private pool: Pool) {}

  async createInvoice(n: NewInvoice) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const ins = await client.query<InvoiceRow>(
        `INSERT INTO invoices (order_id, user_id, customer_email, customer_name, subtotal, tax, total, tax_rate, currency, issued_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10, now()))
         ON CONFLICT (order_id) DO NOTHING RETURNING *`,
        [n.orderId, n.userId, n.customerEmail, n.customerName, n.subtotal, n.tax, n.total, n.taxRate, n.currency, n.issuedAt ?? null],
      );
      if (ins.rows.length === 0) {
        await client.query('ROLLBACK');
        return { invoice: (await this.getByOrder(n.orderId))!, created: false };
      }
      for (const l of n.lines) {
        await client.query('INSERT INTO invoice_lines (invoice_id, product_id, quantity, unit_price) VALUES ($1, $2, $3, $4)', [ins.rows[0].id, l.product_id, l.quantity, l.unit_price]);
      }
      await client.query('COMMIT');
      return { invoice: toInvoice(ins.rows[0]), created: true };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
  async getInvoice(id: string) {
    const r = (await this.pool.query<InvoiceRow>('SELECT * FROM invoices WHERE id = $1', [id])).rows[0];
    return r ? toInvoice(r) : null;
  }
  async getByOrder(orderId: string) {
    const r = (await this.pool.query<InvoiceRow>('SELECT * FROM invoices WHERE order_id = $1', [orderId])).rows[0];
    return r ? toInvoice(r) : null;
  }
  async list({ page, pageSize }: { page: number; pageSize: number }) {
    const r = await this.pool.query<InvoiceRow>('SELECT * FROM invoices ORDER BY number DESC LIMIT $1 OFFSET $2', [pageSize, (page - 1) * pageSize]);
    return r.rows.map(toInvoice);
  }
  async getLines(invoiceId: string) {
    return (await this.pool.query<LineRow>('SELECT product_id, quantity, unit_price FROM invoice_lines WHERE invoice_id = $1 ORDER BY id', [invoiceId])).rows;
  }
  async listCreditNotes(invoiceId: string) {
    return (await this.pool.query<CreditNoteRow>('SELECT * FROM credit_notes WHERE invoice_id = $1 ORDER BY created_at, id', [invoiceId])).rows;
  }
  async addCreditNote(invoiceId: string, amount: number, reason: string | null): Promise<CreditResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const cur = (await client.query<InvoiceRow>('SELECT * FROM invoices WHERE id = $1 FOR UPDATE', [invoiceId])).rows[0];
      if (!cur) {
        await client.query('ROLLBACK');
        return { result: 'not_found' };
      }
      if (amount > cur.total - cur.credited) {
        await client.query('ROLLBACK');
        return { result: 'exceeds', remaining: cur.total - cur.credited };
      }
      const note = (
        await client.query<CreditNoteRow>('INSERT INTO credit_notes (invoice_id, amount, tax, reason) VALUES ($1, $2, $3, $4) RETURNING *', [invoiceId, amount, creditTax(cur, amount), reason])
      ).rows[0];
      const invoice = (await client.query<InvoiceRow>('UPDATE invoices SET credited = credited + $2 WHERE id = $1 RETURNING *', [invoiceId, amount])).rows[0];
      await client.query('COMMIT');
      return { result: 'ok', invoice: toInvoice(invoice), note };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
}

/** In-memory store for unit tests. */
export class MemoryStore implements Store {
  invoices: InvoiceRow[] = [];
  lines = new Map<string, LineRow[]>();
  notes: CreditNoteRow[] = [];
  private seq = 0;

  async createInvoice(n: NewInvoice) {
    const existing = this.invoices.find((i) => i.order_id === n.orderId);
    if (existing) return { invoice: { ...existing }, created: false };
    const row: InvoiceRow = {
      id: randomUUID(), number: ++this.seq, order_id: n.orderId, user_id: n.userId, customer_email: n.customerEmail, customer_name: n.customerName,
      subtotal: n.subtotal, tax: n.tax, total: n.total, tax_rate: n.taxRate, currency: n.currency, credited: 0, issued_at: n.issuedAt ?? new Date(),
    };
    this.invoices.push(row);
    this.lines.set(row.id, n.lines.map((l) => ({ ...l })));
    return { invoice: { ...row }, created: true };
  }
  async getInvoice(id: string) {
    const r = this.invoices.find((i) => i.id === id);
    return r ? { ...r } : null;
  }
  async getByOrder(orderId: string) {
    const r = this.invoices.find((i) => i.order_id === orderId);
    return r ? { ...r } : null;
  }
  async list({ page, pageSize }: { page: number; pageSize: number }) {
    return [...this.invoices].sort((a, b) => b.number - a.number).slice((page - 1) * pageSize, page * pageSize).map((i) => ({ ...i }));
  }
  async getLines(invoiceId: string) {
    return (this.lines.get(invoiceId) ?? []).map((l) => ({ ...l }));
  }
  async listCreditNotes(invoiceId: string) {
    return this.notes.filter((n) => n.invoice_id === invoiceId).map((n) => ({ ...n }));
  }
  async addCreditNote(invoiceId: string, amount: number, reason: string | null): Promise<CreditResult> {
    const inv = this.invoices.find((i) => i.id === invoiceId);
    if (!inv) return { result: 'not_found' };
    if (amount > inv.total - inv.credited) return { result: 'exceeds', remaining: inv.total - inv.credited };
    const note: CreditNoteRow = { id: randomUUID(), invoice_id: invoiceId, amount, tax: creditTax(inv, amount), reason, created_at: new Date() };
    this.notes.push(note);
    inv.credited += amount;
    return { result: 'ok', invoice: { ...inv }, note };
  }
}
