import assert from "node:assert/strict";
import test from "node:test";
import {
  IdempotencyConflictError,
  InvalidTransitionError,
  PaymentExpiredError,
  PaymentNotFoundError,
  ValidationError,
  VerificationNotAuthorizedError,
  createEgyPay,
  dispatchOutbox,
} from "../dist/index.js";
import { InMemoryPaymentStore } from "./support/in-memory-store.mjs";

function fixture(start = "2026-01-01T00:00:00.000Z", authorize = async () => true) {
  let current = new Date(start);
  let next = 0;
  const storage = new InMemoryPaymentStore();
  const egyPay = createEgyPay({
    storage,
    verificationAuthorizer: authorize === null ? undefined : { authorize },
    clock: { now: () => new Date(current) },
    ids: { nextId: () => "id-" + (++next) },
  });
  return {
    storage,
    egyPay,
    advance(milliseconds) {
      current = new Date(current.getTime() + milliseconds);
    },
  };
}

function createInput(overrides = {}) {
  return {
    merchantId: "merchant-1",
    orderId: "order-1",
    amountPiasters: 50_000,
    currency: "EGP",
    method: "instapay",
    expiresAt: "2026-01-02T00:00:00.000Z",
    metadata: null,
    idempotencyKey: "create-order-1",
    ...overrides,
  };
}

function claimInput(intent, overrides = {}) {
  return {
    merchantId: intent.merchantId,
    paymentIntentId: intent.id,
    customerId: "customer-1",
    customerReference: "REF-123",
    reportedAmountPiasters: 50_000,
    evidenceReference: null,
    idempotencyKey: "claim-order-1",
    ...overrides,
  };
}

function verificationInput(intent, claim, overrides = {}) {
  return {
    merchantId: intent.merchantId,
    paymentIntentId: intent.id,
    paymentClaimId: claim.id,
    authorization: {
      actorType: "HUMAN",
      actorId: "reviewer-1",
      sourceType: "merchant_bank_statement",
      sourceReference: "statement-row-4",
      evidenceReference: null,
    },
    note: null,
    idempotencyKey: "verify-order-1",
    ...overrides,
  };
}

test("creates an awaiting intent with integer piasters and a created event", async () => {
  const { egyPay, storage } = fixture();
  const intent = await egyPay.createIntent(createInput());

  assert.equal(intent.status, "AWAITING_PAYMENT");
  assert.equal(intent.amountPiasters, 50_000);
  assert.equal(intent.currency, "EGP");
  assert.equal(storage.snapshot().events[0].type, "payment.intent.created");
});

test("rejects invalid money and unsupported methods before persistence", async () => {
  const { egyPay, storage } = fixture();
  for (const [index, amountPiasters] of [0, -1, 1.25, Number.MAX_SAFE_INTEGER + 1, NaN].entries()) {
    await assert.rejects(
      egyPay.createIntent(createInput({ amountPiasters, idempotencyKey: "bad-" + index })),
      ValidationError,
    );
  }
  await assert.rejects(
    egyPay.createIntent(createInput({ method: "unofficial_api" })),
    ValidationError,
  );
  assert.equal(storage.snapshot().intents.length, 0);
});

test("a submitted customer claim becomes PAID_UNVERIFIED and cannot emit payment.paid", async () => {
  const { egyPay, storage } = fixture();
  const intent = await egyPay.createIntent(createInput());
  const claim = await egyPay.submitClaim(claimInput(intent));

  assert.equal(claim.status, "SUBMITTED");
  assert.equal(storage.snapshot().intents[0].status, "PAID_UNVERIFIED");
  assert.deepEqual(
    storage.snapshot().events.map((item) => item.type),
    ["payment.intent.created", "payment.claim.reported"],
  );
});

test("merchant scope is enforced for claim reads and writes", async () => {
  const { egyPay, storage } = fixture();
  const intent = await egyPay.createIntent(createInput());

  await assert.rejects(
    egyPay.submitClaim(claimInput(intent, { merchantId: "merchant-2", idempotencyKey: "cross-tenant" })),
    PaymentNotFoundError,
  );
  assert.equal(storage.snapshot().claims.length, 0);
  assert.equal(storage.snapshot().intents[0].status, "AWAITING_PAYMENT");
});

test("the verification path requires explicit trusted actor and source context", async () => {
  const { egyPay } = fixture();
  const intent = await egyPay.createIntent(createInput());
  const claim = await egyPay.submitClaim(claimInput(intent));

  await assert.rejects(
    egyPay.verifyPayment(verificationInput(intent, claim, { authorization: undefined })),
    ValidationError,
  );
});

test("verification fails closed when no host authorizer is configured", async () => {
  const { egyPay, storage } = fixture("2026-01-01T00:00:00.000Z", null);
  const intent = await egyPay.createIntent(createInput());
  const claim = await egyPay.submitClaim(claimInput(intent));

  await assert.rejects(
    egyPay.verifyPayment(verificationInput(intent, claim)),
    VerificationNotAuthorizedError,
  );
  assert.equal(storage.snapshot().intents[0].status, "PAID_UNVERIFIED");
});

test("verification is denied when the host authorizer rejects the actor", async () => {
  const { egyPay, storage } = fixture("2026-01-01T00:00:00.000Z", async () => false);
  const intent = await egyPay.createIntent(createInput());
  const claim = await egyPay.submitClaim(claimInput(intent));

  await assert.rejects(
    egyPay.verifyPayment(verificationInput(intent, claim)),
    VerificationNotAuthorizedError,
  );
  assert.equal(storage.snapshot().intents[0].status, "PAID_UNVERIFIED");
  assert.equal(storage.snapshot().verifications.length, 0);
});

test("authorized trusted verification records provenance and emits payment.paid", async () => {
  const authorizationRequests = [];
  const { egyPay, storage } = fixture(undefined, async (request) => {
    authorizationRequests.push(request);
    return true;
  });
  const intent = await egyPay.createIntent(createInput());
  const claim = await egyPay.submitClaim(claimInput(intent));
  const paid = await egyPay.verifyPayment(verificationInput(intent, claim));

  const snapshot = storage.snapshot();
  assert.equal(paid.status, "PAID");
  assert.equal(snapshot.claims[0].status, "APPROVED");
  assert.equal(snapshot.verifications.length, 1);
  assert.equal(snapshot.verifications[0].actorId, "reviewer-1");
  assert.deepEqual(authorizationRequests[0], {
    merchantId: "merchant-1",
    actorType: "HUMAN",
    actorId: "reviewer-1",
    sourceType: "merchant_bank_statement",
    sourceReference: "statement-row-4",
  });
  assert.equal(snapshot.events.filter((item) => item.type === "payment.paid").length, 1);
});

test("rejecting before expiry returns the intent to AWAITING_PAYMENT", async () => {
  const { egyPay, storage } = fixture();
  const intent = await egyPay.createIntent(createInput());
  const claim = await egyPay.submitClaim(claimInput(intent));
  const rejected = await egyPay.rejectClaim(
    verificationInput(intent, claim, { reasonCode: "NO_MATCH", idempotencyKey: "reject-1" }),
  );

  assert.equal(rejected.status, "AWAITING_PAYMENT");
  assert.equal(storage.snapshot().claims[0].status, "REJECTED");
  assert.equal(storage.snapshot().verifications[0].decision, "REJECTED");
});

test("an active claim remains reviewable and may be approved after the deadline", async () => {
  const { egyPay, advance, storage } = fixture();
  const intent = await egyPay.createIntent(createInput({ expiresAt: "2026-01-01T00:01:00.000Z" }));
  const claim = await egyPay.submitClaim(claimInput(intent));
  advance(120_000);

  const paid = await egyPay.verifyPayment(verificationInput(intent, claim));
  assert.equal(paid.status, "PAID");
  assert.equal(storage.snapshot().events.some((item) => item.type === "payment.intent.expired"), false);
});

test("expiry does not erase or expire an active PAID_UNVERIFIED claim", async () => {
  const { egyPay, advance, storage } = fixture();
  const intent = await egyPay.createIntent(createInput({ expiresAt: "2026-01-01T00:01:00.000Z" }));
  await egyPay.submitClaim(claimInput(intent));
  advance(120_000);

  const result = await egyPay.expireIntent(intent.merchantId, intent.id);
  assert.equal(result.status, "PAID_UNVERIFIED");
  assert.equal(storage.snapshot().events.some((item) => item.type === "payment.intent.expired"), false);
});

test("an expired intent rejects new claims and can be expired idempotently", async () => {
  const { egyPay, advance } = fixture();
  const intent = await egyPay.createIntent(createInput({ expiresAt: "2026-01-01T00:01:00.000Z" }));
  advance(120_000);

  await assert.rejects(
    egyPay.submitClaim(claimInput(intent)),
    PaymentExpiredError,
  );
  const first = await egyPay.expireIntent(intent.merchantId, intent.id);
  const second = await egyPay.expireIntent(intent.merchantId, intent.id);
  assert.equal(first.status, "EXPIRED");
  assert.equal(second.version, first.version);
});

test("rejecting an expired claim transitions to EXPIRED", async () => {
  const { egyPay, advance } = fixture();
  const intent = await egyPay.createIntent(createInput({ expiresAt: "2026-01-01T00:01:00.000Z" }));
  const claim = await egyPay.submitClaim(claimInput(intent));
  advance(120_000);

  const result = await egyPay.rejectClaim(
    verificationInput(intent, claim, { reasonCode: "NO_MATCH", idempotencyKey: "reject-expired" }),
  );
  assert.equal(result.status, "EXPIRED");
});

test("idempotent replay returns the original result and mismatched reuse conflicts", async () => {
  const { egyPay, storage } = fixture();
  const first = await egyPay.createIntent(createInput());
  const replay = await egyPay.createIntent(createInput());
  assert.equal(replay.id, first.id);
  assert.equal(storage.snapshot().events.length, 1);

  await assert.rejects(
    egyPay.createIntent(createInput({ amountPiasters: 51_000 })),
    IdempotencyConflictError,
  );
  assert.equal(storage.snapshot().intents.length, 1);
});

test("failed outbox write rolls back state and idempotency record", async () => {
  const { egyPay, storage } = fixture();
  storage.failNextEventAppend();
  await assert.rejects(egyPay.createIntent(createInput()), /Injected outbox failure/);

  const intent = await egyPay.createIntent(createInput());
  assert.equal(intent.status, "AWAITING_PAYMENT");
  assert.equal(storage.snapshot().intents.length, 1);
  assert.equal(storage.snapshot().idempotency.length, 1);
});

test("concurrent identical intent creation produces one intent and one event", async () => {
  const { egyPay, storage } = fixture();
  const [first, second] = await Promise.all([
    egyPay.createIntent(createInput()),
    egyPay.createIntent(createInput()),
  ]);

  assert.equal(first.id, second.id);
  assert.equal(storage.snapshot().intents.length, 1);
  assert.equal(storage.snapshot().events.length, 1);
});

test("concurrent claims cannot create inconsistent or duplicate active claims", async () => {
  const { egyPay, storage } = fixture();
  const intent = await egyPay.createIntent(createInput());
  const outcomes = await Promise.allSettled([
    egyPay.submitClaim(claimInput(intent, { idempotencyKey: "claim-a" })),
    egyPay.submitClaim(claimInput(intent, { idempotencyKey: "claim-b" })),
  ]);

  assert.equal(outcomes.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((item) => item.status === "rejected").length, 1);
  assert.equal(storage.snapshot().claims.length, 1);
  assert.equal(storage.snapshot().intents[0].status, "PAID_UNVERIFIED");
});

test("failed verification outbox write rolls back claim, audit, state, and idempotency", async () => {
  const { egyPay, storage } = fixture();
  const intent = await egyPay.createIntent(createInput());
  const claim = await egyPay.submitClaim(claimInput(intent));
  const input = verificationInput(intent, claim);
  storage.failNextEventAppend();

  await assert.rejects(egyPay.verifyPayment(input), /Injected outbox failure/);
  const rolledBack = storage.snapshot();
  assert.equal(rolledBack.intents[0].status, "PAID_UNVERIFIED");
  assert.equal(rolledBack.claims[0].status, "SUBMITTED");
  assert.equal(rolledBack.verifications.length, 0);
  assert.equal(rolledBack.events.filter((item) => item.type === "payment.paid").length, 0);
  assert.equal(rolledBack.idempotency.length, 2);

  const paid = await egyPay.verifyPayment(input);
  assert.equal(paid.status, "PAID");
  assert.equal(storage.snapshot().verifications.length, 1);
});

test("concurrent verification with different keys commits exactly one approval", async () => {
  const { egyPay, storage } = fixture();
  const intent = await egyPay.createIntent(createInput());
  const claim = await egyPay.submitClaim(claimInput(intent));
  const outcomes = await Promise.allSettled([
    egyPay.verifyPayment(verificationInput(intent, claim, { idempotencyKey: "verify-a" })),
    egyPay.verifyPayment(verificationInput(intent, claim, { idempotencyKey: "verify-b" })),
  ]);

  assert.equal(outcomes.filter((item) => item.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((item) => item.status === "rejected").length, 1);
  assert.equal(storage.snapshot().verifications.length, 1);
  assert.equal(storage.snapshot().events.filter((item) => item.type === "payment.paid").length, 1);
});

test("replaying verification emits no duplicate paid event", async () => {
  const { egyPay, storage } = fixture();
  const intent = await egyPay.createIntent(createInput());
  const claim = await egyPay.submitClaim(claimInput(intent));
  const input = verificationInput(intent, claim);
  await egyPay.verifyPayment(input);
  const replay = await egyPay.verifyPayment(input);

  assert.equal(replay.status, "PAID");
  assert.equal(storage.snapshot().events.filter((item) => item.type === "payment.paid").length, 1);
});

test("outbox delivery acknowledges committed events and does not redeliver acknowledged events", async () => {
  const { egyPay, storage } = fixture();
  await egyPay.createIntent(createInput());
  const delivered = [];
  const clock = { now: () => new Date("2026-01-01T00:00:01.000Z") };
  const ids = { nextId: () => "lease-1" };

  const first = await dispatchOutbox({
    store: storage,
    publish: async (event) => delivered.push(event.id),
    clock,
    ids,
  });
  const second = await dispatchOutbox({
    store: storage,
    publish: async (event) => delivered.push(event.id),
    clock,
    ids,
  });

  assert.deepEqual(first, { claimed: 1, delivered: 1, failed: 0, leaseLost: 0 });
  assert.deepEqual(second, { claimed: 0, delivered: 0, failed: 0, leaseLost: 0 });
  assert.deepEqual(delivered, [storage.snapshot().events[0].id]);
});

test("failed outbox delivery is delayed and retried with the same stable event ID", async () => {
  const { egyPay, storage } = fixture();
  await egyPay.createIntent(createInput());
  let current = new Date("2026-01-01T00:00:01.000Z");
  const clock = { now: () => new Date(current) };
  let calls = 0;
  const deliveredIds = [];

  const first = await dispatchOutbox({
    store: storage,
    publish: async (event) => {
      calls += 1;
      deliveredIds.push(event.id);
      throw new Error("transport unavailable");
    },
    clock,
    ids: { nextId: () => "lease-1" },
  });
  const tooSoon = await dispatchOutbox({
    store: storage,
    publish: async () => { calls += 1; },
    clock,
    ids: { nextId: () => "lease-2" },
  });
  current = new Date(current.getTime() + 1_000);
  const retry = await dispatchOutbox({
    store: storage,
    publish: async (event) => {
      calls += 1;
      deliveredIds.push(event.id);
    },
    clock,
    ids: { nextId: () => "lease-3" },
  });

  assert.equal(first.failed, 1);
  assert.equal(tooSoon.claimed, 0);
  assert.equal(retry.delivered, 1);
  assert.equal(calls, 2);
  assert.equal(deliveredIds[0], deliveredIds[1]);
});

test("concurrent outbox dispatchers lease distinct events", async () => {
  const { egyPay, storage } = fixture();
  await egyPay.createIntent(createInput({ idempotencyKey: "create-a" }));
  await egyPay.createIntent(createInput({ orderId: "order-2", idempotencyKey: "create-b" }));
  const deliveredIds = [];
  const clock = { now: () => new Date("2026-01-01T00:00:01.000Z") };

  const [first, second] = await Promise.all([
    dispatchOutbox({
      store: storage,
      publish: async (event) => deliveredIds.push(event.id),
      limit: 1,
      clock,
      ids: { nextId: () => "lease-a" },
    }),
    dispatchOutbox({
      store: storage,
      publish: async (event) => deliveredIds.push(event.id),
      limit: 1,
      clock,
      ids: { nextId: () => "lease-b" },
    }),
  ]);

  assert.equal(first.delivered + second.delivered, 2);
  assert.equal(new Set(deliveredIds).size, 2);
});
