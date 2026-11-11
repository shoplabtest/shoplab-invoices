import { formatMoney } from './tax.ts';
import type { CreditNoteRow, InvoiceRow, LineRow } from './store.ts';

export const invoiceNumber = (n: number) => `INV-${String(n).padStart(6, '0')}`;

const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`).replace(/[^\x20-\x7e -ÿ]/g, '?');

/** A one-page PDF with plain text lines. Enough for a customer to print or file; no layout engine. */
export function renderInvoicePdf(inv: InvoiceRow, lines: LineRow[], notes: CreditNoteRow[]): Buffer {
  const money = (v: number) => formatMoney(v, inv.currency);
  const text = [
    `Invoice ${invoiceNumber(inv.number)}`,
    `Issued ${inv.issued_at.toISOString().slice(0, 10)}`,
    `Order ${inv.order_id}`,
    '',
    `Bill to: ${inv.customer_name} <${inv.customer_email}>`,
    '',
    ...lines.map((l) => `${l.quantity} x ${l.product_id}${l.unit_price === null ? '' : ` @ ${money(l.unit_price)}`}`),
    '',
    `Subtotal  ${money(inv.subtotal)}`,
    `Tax (${(inv.tax_rate * 100).toFixed(2)}%)  ${money(inv.tax)}`,
    `Total  ${money(inv.total)}`,
    ...notes.map((n) => `Credit note ${n.created_at.toISOString().slice(0, 10)}  -${money(n.amount)}${n.reason ? `  (${n.reason})` : ''}`),
    ...(inv.credited ? [`Amount due after credits  ${money(inv.total - inv.credited)}`] : []),
  ];
  const stream = `BT /F1 12 Tf 14 TL 50 780 Td ${text.map((t) => `(${esc(t)}) Tj T*`).join(' ')} ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 5 0 R /Resources << /Font << /F1 4 0 R >> >> >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
