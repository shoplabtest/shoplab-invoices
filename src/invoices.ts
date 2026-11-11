import type { CustomerDirectory } from './customers.ts';
import type { OrderPlaced } from './events.ts';
import type { InvoiceRow, Store } from './store.ts';
import { splitInclusive } from './tax.ts';

export interface Deps {
  store: Store;
  customers: CustomerDirectory;
}

/** Thrown for events that can never succeed as sent, so the consumer rejects them instead of retrying. */
export class InvalidEvent extends Error {}
export class CustomerNotFound extends Error {}

const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/**
 * Issues the invoice for a placed order. The order total is tax-inclusive, so the invoice total equals
 * what payments charges. The customer's email and name are copied from iam at this moment and never change.
 */
export async function issueForOrder({ store, customers }: Deps, ev: OrderPlaced): Promise<{ invoice: InvoiceRow; created: boolean }> {
  if (!isUuid(ev?.orderId) || !isUuid(ev.userId) || !Number.isInteger(ev.total) || ev.total < 0 || typeof ev.currency !== 'string' || !Array.isArray(ev.lines)) {
    throw new InvalidEvent('malformed order.placed');
  }
  const existing = await store.getByOrder(ev.orderId);
  if (existing) return { invoice: existing, created: false };

  const customer = await customers.find(ev.userId);
  if (!customer) throw new CustomerNotFound(`no customer ${ev.userId}`);
  const { subtotal, tax, rate } = splitInclusive(ev.total, ev.currency);
  return store.createInvoice({
    orderId: ev.orderId,
    userId: ev.userId,
    customerEmail: customer.email,
    customerName: customer.fullName,
    subtotal,
    tax,
    total: ev.total,
    taxRate: rate,
    currency: ev.currency,
    lines: ev.lines.map((l) => ({ product_id: String(l.productId), quantity: Number(l.quantity), unit_price: Number.isInteger(l.unitPrice) ? (l.unitPrice as number) : null })),
    issuedAt: new Date(ev.placedAt),
  });
}
