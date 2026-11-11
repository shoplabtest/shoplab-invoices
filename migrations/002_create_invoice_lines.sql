CREATE TABLE invoice_lines (
  id         bigserial PRIMARY KEY,
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  product_id text NOT NULL,
  quantity   integer NOT NULL CHECK (quantity > 0),
  unit_price integer CHECK (unit_price >= 0)  -- null when orders could not price the line
);
CREATE INDEX invoice_lines_invoice_idx ON invoice_lines (invoice_id);
