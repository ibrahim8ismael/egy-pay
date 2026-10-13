import { ValidationError } from "../domain/errors.js";
import type { PaymentEvent } from "../domain/models.js";
import { systemClock, uuidGenerator, type Clock, type IdGenerator } from "../ports/runtime.js";
import type { OutboxDeliveryStore } from "../ports/storage.js";

export interface DispatchOutboxInput {
  store: OutboxDeliveryStore;
  publish: (event: PaymentEvent) => Promise<void>;
  limit?: number;
  leaseDurationMs?: number;
  clock?: Clock;
  ids?: IdGenerator;
}

export interface DispatchOutboxResult {
  claimed: number;
  delivered: number;
  failed: number;
  leaseLost: number;
}

const DEFAULT_LIMIT = 20;
const DEFAULT_LEASE_DURATION_MS = 30_000;
const MAX_LIMIT = 100;
const MAX_LEASE_DURATION_MS = 15 * 60_000;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 60_000;

/**
 * Deliver one bounded batch of committed outbox events. The publisher runs
 * outside the storage transaction; consumers should deduplicate by event.id.
 */
export async function dispatchOutbox(input: DispatchOutboxInput): Promise<DispatchOutboxResult> {
  if (typeof input.publish !== "function") {
    throw new ValidationError("publish must be a function.");
  }
  const limit = input.limit ?? DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new ValidationError(`limit must be an integer between 1 and ${MAX_LIMIT}.`);
  }
  const leaseDurationMs = input.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
  if (
    !Number.isSafeInteger(leaseDurationMs) ||
    leaseDurationMs < 1_000 ||
    leaseDurationMs > MAX_LEASE_DURATION_MS
  ) {
    throw new ValidationError("leaseDurationMs must be between 1000 and 900000.");
  }

  const clock = input.clock ?? systemClock;
  const ids = input.ids ?? uuidGenerator;
  const now = currentTime(clock);
  const leaseUntil = new Date(now.getTime() + leaseDurationMs).toISOString();
  const leaseToken = ids.nextId();
  if (typeof leaseToken !== "string" || leaseToken.trim().length === 0) {
    throw new ValidationError("The configured ID generator returned an invalid lease token.");
  }
  const claimed = await input.store.claimOutboxEvents({
    now: now.toISOString(),
    leaseUntil,
    limit,
    leaseToken,
  });

  const result: DispatchOutboxResult = {
    claimed: claimed.length,
    delivered: 0,
    failed: 0,
    leaseLost: 0,
  };

  for (const item of claimed) {
    try {
      await input.publish(item.event);
    } catch {
      const retryAt = new Date(
        currentTime(clock).getTime() + retryDelay(item.attempt),
      ).toISOString();
      if (
        await input.store.rescheduleOutboxEvent({
          eventId: item.event.id,
          leaseToken: item.leaseToken,
          availableAt: retryAt,
        })
      ) {
        result.failed += 1;
      } else {
        result.leaseLost += 1;
      }
      continue;
    }

    if (
      await input.store.markOutboxEventDelivered({
        eventId: item.event.id,
        leaseToken: item.leaseToken,
        deliveredAt: currentTime(clock).toISOString(),
      })
    ) {
      result.delivered += 1;
    } else {
      // A later worker may retry an event whose consumer call outlived its lease.
      result.leaseLost += 1;
    }
  }

  return result;
}

function retryDelay(attempt: number): number {
  const exponent = Math.min(Math.max(attempt - 1, 0), 6);
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** exponent);
}

function currentTime(clock: Clock): Date {
  const now = clock.now();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new ValidationError("The configured clock returned an invalid time.");
  }
  return now;
}
