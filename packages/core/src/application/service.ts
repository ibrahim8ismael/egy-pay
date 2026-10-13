import {
  ConcurrentModificationError,
  InvalidTransitionError,
  PaymentExpiredError,
  PaymentNotFoundError,
  ValidationError,
  VerificationNotAuthorizedError,
} from "../domain/errors.js";
import type {
  CurrencyCode,
  IdempotencyOperation,
  JsonObject,
  PaymentClaim,
  PaymentEvent,
  PaymentEventType,
  PaymentIntent,
  VerificationAuthorization,
  VerificationRecord,
} from "../domain/models.js";
import {
  normalizeIsoDate,
  normalizeMetadata,
  optionalText,
  requireText,
  validateAmountPiasters,
  validateCurrency,
  validateMethod,
} from "../domain/validation.js";
import { hashRequest, normalizeIdempotencyKey } from "./idempotency.js";
import { systemClock, uuidGenerator, type Clock, type IdGenerator } from "../ports/runtime.js";
import type { VerificationAuthorizer } from "../ports/authorization.js";
import type { PaymentTransaction, TransactionalPaymentStore } from "../ports/storage.js";

export interface CreatePaymentIntentInput {
  merchantId: string;
  orderId: string;
  amountPiasters: number;
  currency: CurrencyCode;
  method: "vodafone_cash" | "instapay";
  expiresAt?: string | null;
  metadata?: Record<string, unknown> | null;
  idempotencyKey: string;
}

export interface SubmitPaymentClaimInput {
  merchantId: string;
  paymentIntentId: string;
  customerId?: string | null;
  customerReference?: string | null;
  reportedAmountPiasters?: number | null;
  evidenceReference?: string | null;
  idempotencyKey: string;
}

export interface VerifyPaymentInput {
  merchantId: string;
  paymentIntentId: string;
  paymentClaimId: string;
  /** Must be derived from authenticated server-side context; the injected authorizer checks it. */
  authorization: VerificationAuthorization;
  note?: string | null;
  idempotencyKey: string;
}

export interface RejectPaymentClaimInput extends VerifyPaymentInput {
  reasonCode: string;
}

export interface CancelPaymentIntentInput {
  merchantId: string;
  paymentIntentId: string;
  actorId: string;
  idempotencyKey: string;
}

export interface EgyPayDependencies {
  storage: TransactionalPaymentStore;
  verificationAuthorizer?: VerificationAuthorizer;
  clock?: Clock;
  ids?: IdGenerator;
}

export interface EgyPayService {
  createIntent(input: CreatePaymentIntentInput): Promise<PaymentIntent>;
  submitClaim(input: SubmitPaymentClaimInput): Promise<PaymentClaim>;
  verifyPayment(input: VerifyPaymentInput): Promise<PaymentIntent>;
  rejectClaim(input: RejectPaymentClaimInput): Promise<PaymentIntent>;
  cancelIntent(input: CancelPaymentIntentInput): Promise<PaymentIntent>;
  expireIntent(merchantId: string, paymentIntentId: string): Promise<PaymentIntent>;
}

export function createEgyPay(dependencies: EgyPayDependencies): EgyPayService {
  const storage = dependencies.storage;
  const clock = dependencies.clock ?? systemClock;
  const ids = dependencies.ids ?? uuidGenerator;
  const verificationAuthorizer = dependencies.verificationAuthorizer;

  return {
    createIntent: (input) => createIntent(storage, clock, ids, input),
    submitClaim: (input) => submitClaim(storage, clock, ids, input),
    verifyPayment: (input) => verifyPayment(storage, clock, ids, verificationAuthorizer, input),
    rejectClaim: (input) => rejectClaim(storage, clock, ids, verificationAuthorizer, input),
    cancelIntent: (input) => cancelIntent(storage, clock, ids, input),
    expireIntent: (merchantId, paymentIntentId) =>
      expireIntent(storage, clock, ids, merchantId, paymentIntentId),
  };
}

async function createIntent(
  storage: TransactionalPaymentStore,
  clock: Clock,
  ids: IdGenerator,
  input: CreatePaymentIntentInput,
): Promise<PaymentIntent> {
  const merchantId = requireText(input.merchantId, "merchantId");
  const orderId = requireText(input.orderId, "orderId");
  validateAmountPiasters(input.amountPiasters);
  validateCurrency(input.currency);
  validateMethod(input.method);
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const now = currentTime(clock);
  const expiresAt =
    input.expiresAt === undefined || input.expiresAt === null
      ? null
      : normalizeIsoDate(input.expiresAt, "expiresAt");
  if (expiresAt !== null && Date.parse(expiresAt) <= now.getTime()) {
    throw new ValidationError("expiresAt must be in the future.");
  }
  const metadata = normalizeMetadata(input.metadata);
  const requestHash = await hashRequest({
    merchantId,
    orderId,
    amountPiasters: input.amountPiasters,
    currency: input.currency,
    method: input.method,
    expiresAt,
    metadata,
  });
  const createdAt = now.toISOString();

  return storage.runIdempotent<PaymentIntent>(
    idempotentRequest(merchantId, "create_payment_intent", idempotencyKey, requestHash, createdAt),
    async (transaction) => {
      const intent: PaymentIntent = {
        id: ids.nextId(),
        merchantId,
        orderId,
        amountPiasters: input.amountPiasters,
        currency: input.currency,
        method: input.method,
        status: "AWAITING_PAYMENT",
        createdAt,
        updatedAt: createdAt,
        expiresAt,
        version: 1,
        metadata,
      };
      await transaction.insertPaymentIntent(intent);
      await transaction.appendPaymentEvent(
        event(ids, intent, "payment.intent.created", createdAt, {
          amountPiasters: intent.amountPiasters,
          currency: intent.currency,
          method: intent.method,
        }),
      );
      return intent;
    },
  );
}

async function submitClaim(
  storage: TransactionalPaymentStore,
  clock: Clock,
  ids: IdGenerator,
  input: SubmitPaymentClaimInput,
): Promise<PaymentClaim> {
  const merchantId = requireText(input.merchantId, "merchantId");
  const paymentIntentId = requireText(input.paymentIntentId, "paymentIntentId");
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  if (input.reportedAmountPiasters !== undefined && input.reportedAmountPiasters !== null) {
    validateAmountPiasters(input.reportedAmountPiasters, "reportedAmountPiasters");
  }
  const customerId = optionalText(input.customerId, "customerId");
  const customerReference = optionalText(input.customerReference, "customerReference");
  const evidenceReference = optionalText(input.evidenceReference, "evidenceReference");
  const now = currentTime(clock);
  const occurredAt = now.toISOString();
  const requestHash = await hashRequest({
    merchantId,
    paymentIntentId,
    customerId,
    customerReference,
    reportedAmountPiasters: input.reportedAmountPiasters ?? null,
    evidenceReference,
  });

  return storage.runIdempotent<PaymentClaim>(
    idempotentRequest(merchantId, "submit_payment_claim", idempotencyKey, requestHash, occurredAt),
    async (transaction) => {
      const intent = await requireIntent(transaction, merchantId, paymentIntentId);
      assertAwaitingPayment(intent, now);
      if (await transaction.findActivePaymentClaim(merchantId, paymentIntentId)) {
        throw new InvalidTransitionError("submit another claim", "PAID_UNVERIFIED");
      }

      const claim: PaymentClaim = {
        id: ids.nextId(),
        merchantId,
        paymentIntentId,
        customerId,
        customerReference,
        reportedAmountPiasters: input.reportedAmountPiasters ?? null,
        evidenceReference,
        status: "SUBMITTED",
        reportedAt: occurredAt,
        updatedAt: occurredAt,
        version: 1,
      };
      const updatedIntent = transition(intent, "PAID_UNVERIFIED", occurredAt);
      await transaction.insertPaymentClaim(claim);
      await transaction.updatePaymentIntent(updatedIntent, intent.version);
      await transaction.appendPaymentEvent(
        event(ids, updatedIntent, "payment.claim.reported", occurredAt, {
          claimId: claim.id,
          status: "PAID_UNVERIFIED",
        }),
      );
      return claim;
    },
  );
}

async function verifyPayment(
  storage: TransactionalPaymentStore,
  clock: Clock,
  ids: IdGenerator,
  authorizer: VerificationAuthorizer | undefined,
  input: VerifyPaymentInput,
): Promise<PaymentIntent> {
  const merchantId = requireText(input.merchantId, "merchantId");
  const paymentIntentId = requireText(input.paymentIntentId, "paymentIntentId");
  const paymentClaimId = requireText(input.paymentClaimId, "paymentClaimId");
  const authorization = normalizeAuthorization(input.authorization);
  const note = optionalText(input.note, "note", 1000);
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  await requireVerificationAuthorization(authorizer, merchantId, authorization);
  const verifiedAt = currentTime(clock).toISOString();
  const requestHash = await hashRequest({
    merchantId,
    paymentIntentId,
    paymentClaimId,
    authorization,
    note,
  });

  return storage.runIdempotent<PaymentIntent>(
    idempotentRequest(merchantId, "verify_payment", idempotencyKey, requestHash, verifiedAt),
    async (transaction) => {
      const intent = await requireIntent(transaction, merchantId, paymentIntentId);
      const claim = await requireClaim(transaction, merchantId, paymentClaimId);
      await assertVerifiable(transaction, intent, claim, "verify");
      const record = verificationRecord(ids, intent, claim, authorization, "APPROVED", null, note, verifiedAt);
      const updatedClaim: PaymentClaim = {
        ...claim,
        status: "APPROVED",
        updatedAt: verifiedAt,
        version: claim.version + 1,
      };
      const updatedIntent = transition(intent, "PAID", verifiedAt);

      await transaction.updatePaymentClaim(updatedClaim, claim.version);
      await transaction.insertVerificationRecord(record);
      await transaction.updatePaymentIntent(updatedIntent, intent.version);
      await transaction.appendPaymentEvent(
        event(ids, updatedIntent, "payment.paid", verifiedAt, {
          claimId: claim.id,
          verificationRecordId: record.id,
        }),
      );
      return updatedIntent;
    },
  );
}

async function rejectClaim(
  storage: TransactionalPaymentStore,
  clock: Clock,
  ids: IdGenerator,
  authorizer: VerificationAuthorizer | undefined,
  input: RejectPaymentClaimInput,
): Promise<PaymentIntent> {
  const merchantId = requireText(input.merchantId, "merchantId");
  const paymentIntentId = requireText(input.paymentIntentId, "paymentIntentId");
  const paymentClaimId = requireText(input.paymentClaimId, "paymentClaimId");
  const authorization = normalizeAuthorization(input.authorization);
  const reasonCode = requireText(input.reasonCode, "reasonCode", 128);
  const note = optionalText(input.note, "note", 1000);
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  await requireVerificationAuthorization(authorizer, merchantId, authorization);
  const now = currentTime(clock);
  const verifiedAt = now.toISOString();
  const requestHash = await hashRequest({
    merchantId,
    paymentIntentId,
    paymentClaimId,
    authorization,
    reasonCode,
    note,
  });

  return storage.runIdempotent<PaymentIntent>(
    idempotentRequest(merchantId, "reject_payment_claim", idempotencyKey, requestHash, verifiedAt),
    async (transaction) => {
      const intent = await requireIntent(transaction, merchantId, paymentIntentId);
      const claim = await requireClaim(transaction, merchantId, paymentClaimId);
      await assertVerifiable(transaction, intent, claim, "reject");
      const record = verificationRecord(
        ids,
        intent,
        claim,
        authorization,
        "REJECTED",
        reasonCode,
        note,
        verifiedAt,
      );
      const updatedClaim: PaymentClaim = {
        ...claim,
        status: "REJECTED",
        updatedAt: verifiedAt,
        version: claim.version + 1,
      };
      const nextStatus = isPastDeadline(intent, now) ? "EXPIRED" : "AWAITING_PAYMENT";
      const updatedIntent = transition(intent, nextStatus, verifiedAt);

      await transaction.updatePaymentClaim(updatedClaim, claim.version);
      await transaction.insertVerificationRecord(record);
      await transaction.updatePaymentIntent(updatedIntent, intent.version);
      await transaction.appendPaymentEvent(
        event(ids, updatedIntent, "payment.verification.rejected", verifiedAt, {
          claimId: claim.id,
          verificationRecordId: record.id,
          nextStatus,
        }),
      );
      return updatedIntent;
    },
  );
}

async function cancelIntent(
  storage: TransactionalPaymentStore,
  clock: Clock,
  ids: IdGenerator,
  input: CancelPaymentIntentInput,
): Promise<PaymentIntent> {
  const merchantId = requireText(input.merchantId, "merchantId");
  const paymentIntentId = requireText(input.paymentIntentId, "paymentIntentId");
  const actorId = requireText(input.actorId, "actorId");
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const now = currentTime(clock);
  const cancelledAt = now.toISOString();
  const requestHash = await hashRequest({ merchantId, paymentIntentId, actorId });

  return storage.runIdempotent<PaymentIntent>(
    idempotentRequest(merchantId, "cancel_payment_intent", idempotencyKey, requestHash, cancelledAt),
    async (transaction) => {
      const intent = await requireIntent(transaction, merchantId, paymentIntentId);
      assertAwaitingPayment(intent, now);
      if (await transaction.findActivePaymentClaim(merchantId, paymentIntentId)) {
        throw new InvalidTransitionError("cancel", "PAID_UNVERIFIED");
      }
      const updatedIntent = transition(intent, "CANCELLED", cancelledAt);
      await transaction.updatePaymentIntent(updatedIntent, intent.version);
      await transaction.appendPaymentEvent(
        event(ids, updatedIntent, "payment.intent.cancelled", cancelledAt, {
          actorId,
        }),
      );
      return updatedIntent;
    },
  );
}

async function expireIntent(
  storage: TransactionalPaymentStore,
  clock: Clock,
  ids: IdGenerator,
  merchantIdInput: string,
  paymentIntentIdInput: string,
): Promise<PaymentIntent> {
  const merchantId = requireText(merchantIdInput, "merchantId");
  const paymentIntentId = requireText(paymentIntentIdInput, "paymentIntentId");
  const now = currentTime(clock);
  const expiredAt = now.toISOString();

  return storage.transaction(async (transaction) => {
    const intent = await requireIntent(transaction, merchantId, paymentIntentId);
    if (intent.status !== "AWAITING_PAYMENT" || !isPastDeadline(intent, now)) {
      return intent;
    }
    if (await transaction.findActivePaymentClaim(merchantId, paymentIntentId)) {
      return intent;
    }
    const updatedIntent = transition(intent, "EXPIRED", expiredAt);
    await transaction.updatePaymentIntent(updatedIntent, intent.version);
    await transaction.appendPaymentEvent(
      event(ids, updatedIntent, "payment.intent.expired", expiredAt, {}),
    );
    return updatedIntent;
  });
}

function idempotentRequest(
  merchantId: string,
  operation: IdempotencyOperation,
  key: string,
  requestHash: string,
  createdAt: string,
) {
  return {
    scope: { merchantId, operation, key },
    requestHash,
    createdAt,
  };
}

async function requireIntent(
  transaction: PaymentTransaction,
  merchantId: string,
  paymentIntentId: string,
): Promise<PaymentIntent> {
  const intent = await transaction.getPaymentIntent(merchantId, paymentIntentId);
  if (!intent) {
    throw new PaymentNotFoundError();
  }
  return intent;
}

async function requireClaim(
  transaction: PaymentTransaction,
  merchantId: string,
  paymentClaimId: string,
): Promise<PaymentClaim> {
  const claim = await transaction.getPaymentClaim(merchantId, paymentClaimId);
  if (!claim) {
    throw new PaymentNotFoundError();
  }
  return claim;
}

function assertAwaitingPayment(intent: PaymentIntent, now: Date): void {
  if (intent.status !== "AWAITING_PAYMENT") {
    throw new InvalidTransitionError("accept a payment claim", intent.status);
  }
  if (isPastDeadline(intent, now)) {
    throw new PaymentExpiredError();
  }
}

async function assertVerifiable(
  transaction: PaymentTransaction,
  intent: PaymentIntent,
  claim: PaymentClaim,
  operation: "verify" | "reject",
): Promise<void> {
  if (intent.id !== claim.paymentIntentId || intent.merchantId !== claim.merchantId) {
    throw new PaymentNotFoundError();
  }
  if (intent.status !== "PAID_UNVERIFIED" || claim.status !== "SUBMITTED") {
    throw new InvalidTransitionError(operation + " a claim", intent.status);
  }
  const activeClaim = await transaction.findActivePaymentClaim(intent.merchantId, intent.id);
  if (!activeClaim || activeClaim.id !== claim.id) {
    throw new InvalidTransitionError(operation + " a non-active claim", intent.status);
  }
}

function isPastDeadline(intent: PaymentIntent, now: Date): boolean {
  return intent.expiresAt !== null && Date.parse(intent.expiresAt) <= now.getTime();
}

function transition(intent: PaymentIntent, status: PaymentIntent["status"], updatedAt: string): PaymentIntent {
  return {
    ...intent,
    status,
    updatedAt,
    version: intent.version + 1,
  };
}

function event(
  ids: IdGenerator,
  intent: PaymentIntent,
  type: PaymentEventType,
  occurredAt: string,
  payload: JsonObject,
): PaymentEvent {
  return {
    id: ids.nextId(),
    merchantId: intent.merchantId,
    paymentIntentId: intent.id,
    type,
    occurredAt,
    schemaVersion: 1,
    aggregateVersion: intent.version,
    payload,
  };
}

function verificationRecord(
  ids: IdGenerator,
  intent: PaymentIntent,
  claim: PaymentClaim,
  authorization: VerificationAuthorization,
  decision: "APPROVED" | "REJECTED",
  reasonCode: string | null,
  note: string | null,
  verifiedAt: string,
): VerificationRecord {
  return {
    id: ids.nextId(),
    merchantId: intent.merchantId,
    paymentIntentId: intent.id,
    paymentClaimId: claim.id,
    decision,
    actorType: authorization.actorType,
    actorId: authorization.actorId,
    sourceType: authorization.sourceType,
    sourceReference: authorization.sourceReference,
    evidenceReference: authorization.evidenceReference,
    reasonCode,
    note,
    verifiedAt,
  };
}

async function requireVerificationAuthorization(
  authorizer: VerificationAuthorizer | undefined,
  merchantId: string,
  authorization: VerificationAuthorization,
): Promise<void> {
  if (!authorizer) {
    throw new VerificationNotAuthorizedError();
  }
  const authorized = await authorizer.authorize({
    merchantId,
    actorType: authorization.actorType,
    actorId: authorization.actorId,
    sourceType: authorization.sourceType,
    sourceReference: authorization.sourceReference,
  });
  if (!authorized) {
    throw new VerificationNotAuthorizedError();
  }
}

function normalizeAuthorization(value: unknown): VerificationAuthorization {
  if (typeof value !== "object" || value === null) {
    throw new ValidationError("An explicit verification authorization is required.");
  }
  const authorization = value as Record<string, unknown>;
  if (authorization.actorType !== "HUMAN" && authorization.actorType !== "TRUSTED_ADAPTER") {
    throw new ValidationError("authorization.actorType must be HUMAN or TRUSTED_ADAPTER.");
  }
  return {
    actorType: authorization.actorType,
    actorId: requireText(authorization.actorId, "authorization.actorId"),
    sourceType: requireText(authorization.sourceType, "authorization.sourceType", 128),
    sourceReference: optionalText(authorization.sourceReference, "authorization.sourceReference"),
    evidenceReference: optionalText(authorization.evidenceReference, "authorization.evidenceReference"),
  };
}

function currentTime(clock: Clock): Date {
  const now = clock.now();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new ValidationError("The configured clock returned an invalid time.");
  }
  return now;
}
