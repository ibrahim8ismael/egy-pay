import {
  ConcurrentModificationError,
  IdempotencyConflictError,
  StorageConflictError,
} from "../../dist/index.js";

function clone(value) {
  return structuredClone(value);
}

function cloneState(state) {
  return {
    intents: new Map(Array.from(state.intents, ([key, value]) => [key, clone(value)])),
    claims: new Map(Array.from(state.claims, ([key, value]) => [key, clone(value)])),
    verifications: new Map(Array.from(state.verifications, ([key, value]) => [key, clone(value)])),
    events: new Map(Array.from(state.events, ([key, value]) => [key, clone(value)])),
    idempotency: new Map(Array.from(state.idempotency, ([key, value]) => [key, clone(value)])),
  };
}

class Mutex {
  #tail = Promise.resolve();

  async run(work) {
    const previous = this.#tail;
    let release;
    this.#tail = new Promise((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
}

function idempotencyIndex(scope) {
  return JSON.stringify([scope.merchantId, scope.operation, scope.key]);
}

function transactionFor(state, consumeEventFailure) {
  return {
    async getPaymentIntent(merchantId, paymentIntentId) {
      const value = state.intents.get(paymentIntentId);
      return value && value.merchantId === merchantId ? clone(value) : null;
    },
    async insertPaymentIntent(intent) {
      if (state.intents.has(intent.id)) {
        throw new StorageConflictError("Payment intent ID already exists.");
      }
      state.intents.set(intent.id, clone(intent));
    },
    async updatePaymentIntent(intent, expectedVersion) {
      const current = state.intents.get(intent.id);
      if (!current || current.merchantId !== intent.merchantId || current.version !== expectedVersion) {
        throw new ConcurrentModificationError();
      }
      if (intent.version !== expectedVersion + 1) {
        throw new StorageConflictError("Payment intent version must increment by one.");
      }
      state.intents.set(intent.id, clone(intent));
    },
    async getPaymentClaim(merchantId, paymentClaimId) {
      const value = state.claims.get(paymentClaimId);
      return value && value.merchantId === merchantId ? clone(value) : null;
    },
    async findActivePaymentClaim(merchantId, paymentIntentId) {
      for (const claim of state.claims.values()) {
        if (
          claim.merchantId === merchantId &&
          claim.paymentIntentId === paymentIntentId &&
          claim.status === "SUBMITTED"
        ) {
          return clone(claim);
        }
      }
      return null;
    },
    async insertPaymentClaim(claim) {
      if (state.claims.has(claim.id)) {
        throw new StorageConflictError("Payment claim ID already exists.");
      }
      state.claims.set(claim.id, clone(claim));
    },
    async updatePaymentClaim(claim, expectedVersion) {
      const current = state.claims.get(claim.id);
      if (!current || current.merchantId !== claim.merchantId || current.version !== expectedVersion) {
        throw new ConcurrentModificationError();
      }
      if (claim.version !== expectedVersion + 1) {
        throw new StorageConflictError("Payment claim version must increment by one.");
      }
      state.claims.set(claim.id, clone(claim));
    },
    async insertVerificationRecord(record) {
      if (state.verifications.has(record.id)) {
        throw new StorageConflictError("Verification record ID already exists.");
      }
      state.verifications.set(record.id, clone(record));
    },
    async appendPaymentEvent(event) {
      if (consumeEventFailure()) {
        throw new Error("Injected outbox failure.");
      }
      if (state.events.has(event.id)) {
        throw new StorageConflictError("Payment event ID already exists.");
      }
      state.events.set(event.id, clone(event));
    },
  };
}

export class InMemoryPaymentStore {
  #state = {
    intents: new Map(),
    claims: new Map(),
    verifications: new Map(),
    events: new Map(),
    idempotency: new Map(),
  };
  #mutex = new Mutex();
  #failNextEvent = false;

  failNextEventAppend() {
    this.#failNextEvent = true;
  }

  #makeTransaction(state) {
    return transactionFor(state, () => {
      if (!this.#failNextEvent) {
        return false;
      }
      this.#failNextEvent = false;
      return true;
    });
  }

  async transaction(work) {
    return this.#mutex.run(async () => {
      const draft = cloneState(this.#state);
      const result = await work(this.#makeTransaction(draft));
      this.#state = draft;
      return clone(result);
    });
  }

  async runIdempotent(request, work) {
    return this.#mutex.run(async () => {
      const draft = cloneState(this.#state);
      const key = idempotencyIndex(request.scope);
      const existing = draft.idempotency.get(key);
      if (existing) {
        if (existing.requestHash !== request.requestHash) {
          throw new IdempotencyConflictError();
        }
        return clone(existing.result);
      }

      const result = await work(this.#makeTransaction(draft));
      draft.idempotency.set(key, {
        merchantId: request.scope.merchantId,
        operation: request.scope.operation,
        key: request.scope.key,
        requestHash: request.requestHash,
        result: clone(result),
        createdAt: request.createdAt,
      });
      this.#state = draft;
      return clone(result);
    });
  }

  snapshot() {
    return {
      intents: Array.from(this.#state.intents.values(), clone),
      claims: Array.from(this.#state.claims.values(), clone),
      verifications: Array.from(this.#state.verifications.values(), clone),
      events: Array.from(this.#state.events.values(), clone),
      idempotency: Array.from(this.#state.idempotency.values(), clone),
    };
  }
}
