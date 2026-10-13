import type { VerificationActorType } from "../domain/models.js";

export interface VerificationAuthorizationRequest {
  merchantId: string;
  actorType: VerificationActorType;
  actorId: string;
  sourceType: string;
  sourceReference: string | null;
}

/**
 * Implement this with the host application's server-side identity and role checks.
 * Never derive the actor identity from customer-controlled request fields.
 */
export interface VerificationAuthorizer {
  authorize(request: VerificationAuthorizationRequest): Promise<boolean>;
}
