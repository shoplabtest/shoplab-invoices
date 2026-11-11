# shoplab-invoices

One invoice per order, with tax, credit notes and a PDF. Express + Postgres. It is an internal service: the browser never calls it, and the gateway only lets staff reach it.

| Endpoint | Notes |
| --- | --- |
| `GET /invoices` | newest first; `page`, `pageSize` (default 50, max 200) |
| `GET /invoices/order/:orderId` | the invoice for an order, `404` if none |
| `GET /invoices/:id/pdf` | a one-page PDF |
| `POST /invoices/:id/credit-notes` | `{ amount, reason? }` in minor units. Several partial credits are allowed; their sum may not exceed the invoice total (`409`) |

Every `/invoices` route requires the `x-internal-key` header (`INVOICES_INTERNAL_KEY`, the same value the gateway adds). `/healthz` is open. Without a configured key every request is refused, and the service will not start in production without one.

**Invoices come from events.** The service consumes `order.placed` on queue `invoices.events`. The order total is tax-inclusive, so the invoice total equals what `shoplab-payments` charged: `tax` is split out by currency (USD 8.25 %, EUR and GBP 20 %; a currency with no rule is rejected, never taxed at zero). A redelivered event creates nothing new. A malformed event, or an order whose customer cannot be found, is rejected without retry and logged.

**Customer data comes from iam's database.** The invoice needs the customer's `email` and `full_name`, and the service reads them straight from iam's `users` table (`src/customers.ts`) instead of calling iam. The values are copied onto the invoice when it is issued and never change afterwards. The connection (`IAM_DATABASE_URL`) uses a role that can read only those three columns:

```sql
CREATE ROLE invoices_reader LOGIN PASSWORD '...';
GRANT CONNECT ON DATABASE iam TO invoices_reader;
GRANT USAGE ON SCHEMA public TO invoices_reader;
GRANT SELECT (id, email, full_name) ON users TO invoices_reader;
```

So `users.id`, `users.email` and `users.full_name` are a contract with iam even though iam never hears about it.

Env: `DATABASE_URL`, `IAM_DATABASE_URL`, `RABBITMQ_URL` (optional; without it no invoices are issued), `INVOICES_INTERNAL_KEY`, `PORT` (3006).

```
npm test                          # in-memory store
TEST_DATABASE_URL=postgres://postgres:pw@localhost:5432/test npm test   # also migrations, seed, concurrency and the narrow role
npm run seed                      # the same 100 invoices every time
```

The seed uses the same generator as `shoplab-orders`, so totals and shoppers line up, but its order ids are derived here, not orders' own.
