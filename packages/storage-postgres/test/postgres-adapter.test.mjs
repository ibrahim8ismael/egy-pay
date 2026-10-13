import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import {
  ConcurrentModificationError,
  IdempotencyConflictError,
  StorageConflictError,
  createEgyPay,
  dispatchOutbox,
} from "egy-pay";
import { migratePostgres, PostgresPaymentStore } from "../dist/index.js";

const databaseUrl = process.env.EGY_PAY_TEST_DATABASE_URL;

test(
  "PostgreSQL transactional storage contract",
  { skip: databaseUrl ? false : "Set EGY_PAY_TEST_DATABASE_URL to run PostgreSQL integration tests." },
  async (t) => {
    const adminPool = new Pool({ connectionString: databaseUrl, max: 2 });
    const schema = "egy_pay_test_" + randomUUID().replaceAll("-", "");
    await adminPool.query("CREATE SCHEMA " + schema);
    const pool = new Pool({
      connectionString: databaseUrl,
      options: "-c search_path=" + schema,
      max: 10,
    });

    try {
      await migratePostgres(pool);
      await migratePostgres(pool);
      const storage = new PostgresPaymentStore(pool);

      async function reset() {
        await pool.query(
          "TRUNCATE TABLE egy_pay_reconciliation_records, egy_pay_payment_events, " +
            "egy_pay_verification_records, egy_pay_payment_claims, " +
            "egy_pay_payment_intents, egy_pay_idempotency_records",
        );
      }

      function sequentialIds() {
        let counter = 0;
        return { nextId: () => "test-id-" + (++counter) };
      }

      function service(ids = sequentialIds()) {
        return createEgyPay({
          storage,
          verificationAuthorizer: { authorize: async () => true },
          ids,
        });
      }

      function intentInput(overrides = {}) {
        return {
          merchantId: "merchant-pg",
          orderId: "order-pg",
          amountPiasters: 50_000,
          currency: "EGP",
          method: "instapay",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          idempotencyKey: "create-pg",
          ...overrides,
        };
      }

      function claimInput(intent, overrides = {}) {
        return {
          merchantId: intent.merchantId,
          paymentIntentId: intent.id,
          customerReference: "CUSTOMER-REF",
          idempotencyKey: "claim-pg",
          ...overrides,
        };
      }

      function verifyInput(intent, claim, overrides = {}) {
        return {
          merchantId: intent.merchantId,
          paymentIntentId: intent.id,
          paymentClaimId: claim.id,
          authorization: {
            actorType: "HUMAN",
            actorId: "reviewer-pg",
            sourceType: "merchant_statement",
            sourceReference: "row-1",
            evidenceReference: null,
          },
          idempotencyKey: "verify-pg",
          ...overrides,
        };
      }

      function reconciliationInput(intent, overrides = {}) {
        return {
          merchantId: intent.merchantId,
          sourceType: "merchant_statement",
          sourceRecordId: "statement-row-pg-1",
          transactionReference: "CUSTOMER-REF",
          amountPiasters: intent.amountPiasters,
          currency: intent.currency,
          method: intent.method,
          occurredAt: new Date().toISOString(),
          actorId: "trusted-importer-pg",
          ...overrides,
        };
      }

      async function count(table, condition = "", values = []) {
        const result = await pool.query(
          "SELECT count(*)::int AS count FROM " + table +
            (condition ? " WHERE " + condition : ""),
          values,
        );
        return result.rows[0].count;
      }

      await t.test("migration applies once and can be rerun", async () => {
        const result = await pool.query(
          "SELECT count(*)::int AS count FROM egy_pay_schema_migrations " +
          "WHERE version IN ($1, $2, $3)",
          ["001_initial", "002_outbox_delivery", "003_trusted_reconciliation"],
        );
        assert.equal(result.rows[0].count, 3);
      });

      await t.test("persists verified payment and audit/outbox atomically", async () => {
        await reset();
        const egyPay = service();
        const intent = await egyPay.createIntent(intentInput());
        const claim = await egyPay.submitClaim(claimInput(intent));
        assert.equal(intent.status, "AWAITING_PAYMENT");

        const unverified = await pool.query(
          "SELECT status FROM egy_pay_payment_intents WHERE merchant_id = $1 AND id = $2",
          [intent.merchantId, intent.id],
        );
        assert.equal(unverified.rows[0].status, "PAID_UNVERIFIED");

        const paid = await egyPay.verifyPayment(verifyInput(intent, claim));
        assert.equal(paid.status, "PAID");
        assert.equal(await count("egy_pay_verification_records"), 1);
        assert.equal(await count("egy_pay_payment_events", "type = $1", ["payment.paid"]), 1);
        assert.equal(await count("egy_pay_idempotency_records"), 3);
      });

      await t.test("delivers outbox rows after claim and acknowledges them", async () => {
        await reset();
        const egyPay = service();
        await egyPay.createIntent(intentInput());
        const delivered = [];
        const result = await dispatchOutbox({
          store: storage,
          publish: async (event) => delivered.push(event.id),
          clock: { now: () => new Date(Date.now() + 5_000) },
          ids: { nextId: () => "dispatcher-lease" },
        });

        assert.equal(result.claimed, 1);
        assert.equal(result.delivered, 1);
        assert.equal(await count("egy_pay_payment_events", "delivered_at IS NOT NULL"), 1);
        assert.equal(delivered.length, 1);
        assert.equal((await dispatchOutbox({
          store: storage,
          publish: async (event) => delivered.push(event.id),
          clock: { now: () => new Date(Date.now() + 5_000) },
          ids: { nextId: () => "dispatcher-lease-2" },
        })).claimed, 0);
      });

      await t.test("retries failed event delivery after its backoff using the same event ID", async () => {
        await reset();
        await service().createIntent(intentInput());
        let now = new Date(Date.now() + 5_000);
        const clock = { now: () => new Date(now) };
        const eventIds = [];
        const failed = await dispatchOutbox({
          store: storage,
          publish: async (event) => {
            eventIds.push(event.id);
            throw new Error("temporary publisher failure");
          },
          clock,
          ids: { nextId: () => "failed-lease" },
        });
        const tooSoon = await dispatchOutbox({
          store: storage,
          publish: async () => assert.fail("event should still be in backoff"),
          clock,
          ids: { nextId: () => "early-lease" },
        });
        now = new Date(now.getTime() + 1_000);
        const retried = await dispatchOutbox({
          store: storage,
          publish: async (event) => eventIds.push(event.id),
          clock,
          ids: { nextId: () => "retry-lease" },
        });

        assert.equal(failed.failed, 1);
        assert.equal(tooSoon.claimed, 0);
        assert.equal(retried.delivered, 1);
        assert.equal(eventIds[0], eventIds[1]);
      });

      await t.test("parallel dispatchers claim separate rows with SKIP LOCKED", async () => {
        await reset();
        const egyPay = service();
        await egyPay.createIntent(intentInput({ idempotencyKey: "create-pg-a" }));
        await egyPay.createIntent(intentInput({
          orderId: "order-pg-b",
          idempotencyKey: "create-pg-b",
        }));
        const deliveredIds = [];
        const clock = { now: () => new Date(Date.now() + 5_000) };
        const publish = async (event) => {
          deliveredIds.push(event.id);
          await new Promise((resolve) => setTimeout(resolve, 25));
        };
        const [first, second] = await Promise.all([
          dispatchOutbox({
            store: storage,
            publish,
            limit: 1,
            clock,
            ids: { nextId: () => "parallel-lease-a" },
          }),
          dispatchOutbox({
            store: storage,
            publish,
            limit: 1,
            clock,
            ids: { nextId: () => "parallel-lease-b" },
          }),
        ]);

        assert.equal(first.delivered + second.delivered, 2);
        assert.equal(new Set(deliveredIds).size, 2);
      });

      await t.test("trusted reconciliation stores a unique match without confirming payment", async () => {
        await reset();
        const egyPay = service();
        const intent = await egyPay.createIntent(intentInput());
        const claim = await egyPay.submitClaim(claimInput(intent));
        const input = reconciliationInput(intent);
        const record = await egyPay.reconcileTrustedTransaction(input);
        const replay = await egyPay.reconcileTrustedTransaction(input);

        assert.equal(record.status, "MATCHED");
        assert.equal(record.candidateCount, 1);
        assert.deepEqual(record.candidatePaymentIntentIds, [intent.id]);
        assert.deepEqual(record.candidatePaymentClaimIds, [claim.id]);
        assert.equal(replay.id, record.id);
        assert.equal(await count("egy_pay_reconciliation_records"), 1);
        assert.equal(await count("egy_pay_verification_records"), 0);
        assert.equal(await count("egy_pay_payment_events", "type = $1", ["payment.paid"]), 0);
        const persistedIntent = await pool.query(
          "SELECT status FROM egy_pay_payment_intents WHERE id = $1",
          [intent.id],
        );
        assert.equal(persistedIntent.rows[0].status, "PAID_UNVERIFIED");
        await assert.rejects(
          egyPay.reconcileTrustedTransaction({ ...input, amountPiasters: 50_001 }),
          IdempotencyConflictError,
        );
      });

      await t.test("ambiguous trusted records remain marked for review", async () => {
        await reset();
        const egyPay = service();
        const first = await egyPay.createIntent(intentInput({ idempotencyKey: "create-reconcile-a" }));
        await egyPay.submitClaim(claimInput(first, { idempotencyKey: "claim-reconcile-a" }));
        const second = await egyPay.createIntent(intentInput({
          orderId: "order-reconcile-b",
          idempotencyKey: "create-reconcile-b",
        }));
        await egyPay.submitClaim(claimInput(second, { idempotencyKey: "claim-reconcile-b" }));

        const record = await egyPay.reconcileTrustedTransaction(reconciliationInput(first));
        assert.equal(record.status, "AMBIGUOUS");
        assert.equal(record.candidateCount, 2);
        assert.equal(record.candidatePaymentClaimIds.length, 2);
        assert.equal(await count("egy_pay_payment_events", "type = $1", ["payment.paid"]), 0);
      });

      await t.test("concurrent duplicate source rows create one reconciliation record", async () => {
        await reset();
        const egyPay = service();
        const intent = await egyPay.createIntent(intentInput());
        await egyPay.submitClaim(claimInput(intent));
        const input = reconciliationInput(intent);
        const [first, second] = await Promise.all([
          egyPay.reconcileTrustedTransaction(input),
          egyPay.reconcileTrustedTransaction(input),
        ]);

        assert.equal(first.id, second.id);
        assert.equal(await count("egy_pay_reconciliation_records"), 1);
      });

      await t.test("reconciliation fails closed when the adapter is not authorized", async () => {
        await reset();
        const authorizedService = service();
        const intent = await authorizedService.createIntent(intentInput());
        await authorizedService.submitClaim(claimInput(intent));
        const deniedService = createEgyPay({
          storage,
          verificationAuthorizer: { authorize: async () => false },
        });
        await assert.rejects(
          deniedService.reconcileTrustedTransaction(reconciliationInput(intent)),
          /not authorized/,
        );
        assert.equal(await count("egy_pay_reconciliation_records"), 0);
      });

      await t.test("failed outbox insert rolls back claim, verification, state, and idempotency", async () => {
        await reset();
        const generated = [
          "intent-1",
          "event-existing",
          "claim-1",
          "claim-event",
          "verification-1",
          "event-existing",
        ];
        const ids = { nextId: () => generated.shift() };
        const egyPay = service(ids);
        const intent = await egyPay.createIntent(intentInput());
        const claim = await egyPay.submitClaim(claimInput(intent));

        await assert.rejects(
          egyPay.verifyPayment(verifyInput(intent, claim)),
          StorageConflictError,
        );
        const intentRow = await pool.query(
          "SELECT status FROM egy_pay_payment_intents WHERE id = $1",
          [intent.id],
        );
        const claimRow = await pool.query(
          "SELECT status FROM egy_pay_payment_claims WHERE id = $1",
          [claim.id],
        );
        assert.equal(intentRow.rows[0].status, "PAID_UNVERIFIED");
        assert.equal(claimRow.rows[0].status, "SUBMITTED");
        assert.equal(await count("egy_pay_verification_records"), 0);
        assert.equal(await count("egy_pay_payment_events", "type = $1", ["payment.paid"]), 0);
        assert.equal(await count("egy_pay_idempotency_records"), 2);

        let retryId = 0;
        const retry = service({ nextId: () => "retry-id-" + (++retryId) });
        const paid = await retry.verifyPayment(verifyInput(intent, claim));
        assert.equal(paid.status, "PAID");
        assert.equal(await count("egy_pay_verification_records"), 1);
      });

      await t.test("same-key concurrent requests serialize and replay one result", async () => {
        await reset();
        const egyPay = service();
        const input = intentInput();
        const [first, second] = await Promise.all([
          egyPay.createIntent(input),
          egyPay.createIntent(input),
        ]);

        assert.equal(first.id, second.id);
        assert.equal(await count("egy_pay_payment_intents"), 1);
        assert.equal(await count("egy_pay_payment_events"), 1);
        assert.equal(await count("egy_pay_idempotency_records"), 1);
      });

      await t.test("same key with changed input conflicts without side effects", async () => {
        await reset();
        const egyPay = service();
        await egyPay.createIntent(intentInput());
        await assert.rejects(
          egyPay.createIntent(intentInput({ amountPiasters: 51_000 })),
          IdempotencyConflictError,
        );
        assert.equal(await count("egy_pay_payment_intents"), 1);
      });

      await t.test("concurrent claims cannot create more than one active claim", async () => {
        await reset();
        const egyPay = service();
        const intent = await egyPay.createIntent(intentInput());
        const results = await Promise.allSettled([
          egyPay.submitClaim(claimInput(intent, { idempotencyKey: "claim-a" })),
          egyPay.submitClaim(claimInput(intent, { idempotencyKey: "claim-b" })),
        ]);
        assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
        assert.equal(results.filter((result) => result.status === "rejected").length, 1);
        assert.equal(await count("egy_pay_payment_claims", "status = $1", ["SUBMITTED"]), 1);
        assert.equal(await count("egy_pay_payment_events", "type = $1", ["payment.claim.reported"]), 1);
      });

      await t.test("concurrent approvals commit exactly one verification and paid event", async () => {
        await reset();
        const egyPay = service();
        const intent = await egyPay.createIntent(intentInput());
        const claim = await egyPay.submitClaim(claimInput(intent));
        const results = await Promise.allSettled([
          egyPay.verifyPayment(verifyInput(intent, claim, { idempotencyKey: "verify-a" })),
          egyPay.verifyPayment(verifyInput(intent, claim, { idempotencyKey: "verify-b" })),
        ]);
        assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
        assert.equal(results.filter((result) => result.status === "rejected").length, 1);
        assert.equal(await count("egy_pay_verification_records"), 1);
        assert.equal(await count("egy_pay_payment_events", "type = $1", ["payment.paid"]), 1);
      });

      await t.test("version compare-and-swap rejects stale updates", async () => {
        await reset();
        const egyPay = service();
        const intent = await egyPay.createIntent(intentInput());
        await assert.rejects(
          storage.transaction((tx) =>
            tx.updatePaymentIntent(
              { ...intent, status: "CANCELLED", updatedAt: new Date().toISOString(), version: 1 },
              0,
            ),
          ),
          ConcurrentModificationError,
        );
        const row = await pool.query(
          "SELECT status, version FROM egy_pay_payment_intents WHERE id = $1",
          [intent.id],
        );
        assert.equal(row.rows[0].status, "AWAITING_PAYMENT");
        assert.equal(row.rows[0].version, 1);
      });
    } finally {
      await pool.end();
      await adminPool.query("DROP SCHEMA " + schema + " CASCADE");
      await adminPool.end();
    }
  },
);
