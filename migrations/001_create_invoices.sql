CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SEQUENCE invoice_number_seq;

CREATE TABLE invoices (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number         integer NOT NULL DEFAULT nextval('invoice_number_seq') UNIQUE,
  order_id       uuid NOT NULL UNIQUE,  -- one invoice per order; makes order.placed idempotent
  user_id        uuid NOT NULL,
  customer_email text NOT NULL,         -- copied from iam's users table when the invoice is issued
  customer_name  text NOT NULL,
  subtotal       integer NOT NULL CHECK (subtotal >= 0),
  tax            integer NOT NULL CHECK (tax >= 0),
  total          integer NOT NULL CHECK (total >= 0),
  tax_rate       numeric(6, 4) NOT NULL,
  currency       text NOT NULL,
  credited       integer NOT NULL DEFAULT 0 CHECK (credited >= 0 AND credited <= total),
  issued_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (subtotal + tax = total)
);
CREATE INDEX invoices_user_idx ON invoices (user_id, issued_at DESC);
