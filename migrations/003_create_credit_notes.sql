CREATE TABLE credit_notes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES invoices(id),
  amount     integer NOT NULL CHECK (amount > 0),
  tax        integer NOT NULL CHECK (tax >= 0),
  reason     text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX credit_notes_invoice_idx ON credit_notes (invoice_id);
