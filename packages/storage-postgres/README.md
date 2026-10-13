# @egy-pay/storage-postgres

The first production persistence adapter for egy-pay. It implements the core transactional storage port using node-postgres and PostgreSQL.

## Setup

The application owns the pool lifecycle and should create one pool per application process, not one per request:

```ts
import { Pool } from "pg";
import { createEgyPay } from "@egy-pay/core";
import { migratePostgres, PostgresPaymentStore } from "@egy-pay/storage-postgres";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
await migratePostgres(pool);

const egyPay = createEgyPay({
  storage: new PostgresPaymentStore(pool),
  verificationAuthorizer,
});
```

Run migrations as a deployment step where possible. For a CLI migration, set `EGY_PAY_DATABASE_URL` and run `pnpm --filter @egy-pay/storage-postgres migrate`. Do not run production migrations automatically on every web-server startup unless that is an explicit deployment policy.

## Guarantees

- State, claim, verification, idempotency, and outbox writes share one PostgreSQL transaction.
- Idempotency uses a transaction-scoped advisory lock plus a unique key scoped by merchant and operation. Matching retries replay the original JSON result; changed input with the same key raises an idempotency conflict.
- Intent and claim updates compare the expected version. Concurrent writes cannot silently overwrite a newer state.
- A partial unique index allows at most one submitted claim per intent.
- PostgreSQL constraints enforce merchant-scoped relationships, supported initial methods/currency, valid statuses, and positive integer-piaster amounts.
- The adapter uses the caller-provided pool and checks out one client for each transaction. The caller must close the pool during process shutdown.

## Outbox delivery

`dispatchOutbox` claims a bounded batch with short leases, commits those leases, and then calls the host publisher outside the database transaction. A successful call marks the event delivered. A failed call releases it with capped exponential backoff. Expired leases become available again if a worker stops before acknowledging an event.

Delivery is **at-least-once**. A publisher or downstream consumer may receive the same event more than once if delivery succeeded but the acknowledgement was lost. Deduplicate by the stable `event.id` before triggering side effects such as fulfillment. Run `dispatchOutbox` from a worker or scheduled job; do not invoke fulfillment from inside a payment transaction.

```ts
import { dispatchOutbox } from "@egy-pay/core";

const result = await dispatchOutbox({
  store: new PostgresPaymentStore(pool),
  publish: async (event) => {
    await eventBus.publish({ id: event.id, type: event.type, payload: event.payload });
  },
  limit: 25,
});

// Monitor counts without logging payment payloads or customer references.
metrics.outboxDelivered(result.delivered);
metrics.outboxFailed(result.failed);
```

## Integration tests

Set `EGY_PAY_TEST_DATABASE_URL` to a dedicated test database URL and run `pnpm --filter @egy-pay/storage-postgres test`. Tests create a uniquely named schema and drop only that schema afterward. If the variable is absent, PostgreSQL integration tests are reported as skipped.

Never point the integration-test variable at a production database. The test suite creates and drops its own schema.
