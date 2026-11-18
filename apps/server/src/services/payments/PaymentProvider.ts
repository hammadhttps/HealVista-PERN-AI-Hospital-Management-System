/**
 * One interface, one gateway.
 *
 * Nothing outside `payments/*.provider.ts` may import a gateway SDK — call sites
 * depend on this interface only. That keeps Stripe swappable and lets tests
 * substitute a fake without network access.
 */

export interface PaymentIntent {
  /** The gateway's own id for this attempt. Stored as `Payment.providerRef`. */
  providerRef: string;
  /** Passed to the client SDK to complete the payment. */
  clientSecret: string;
  amount: string;
  currency: string;
}

export interface RefundResult {
  refundRef: string;
  amount: string;
}

/** A webhook that has been verified and normalised into terms billing understands. */
export interface VerifiedWebhookEvent {
  /** The gateway's event id — the idempotency key. */
  eventId: string;
  type: "payment_succeeded" | "payment_failed" | "payment_canceled" | "refunded" | "ignored";
  providerRef: string | null;
  /**
   * For `refunded`, the **cumulative** amount refunded on the payment so far — not
   * the delta. Applying a cumulative figure is idempotent under redelivery and
   * out-of-order arrival; adding deltas is not.
   */
  amount: string | null;
}

/**
 * An existing intent's state, read back from the gateway — the source of truth for
 * whether money moved. Used to reuse an open checkout instead of opening a second
 * one, and to reconcile payments whose webhook never arrived.
 */
export interface IntentStatus {
  providerRef: string;
  /** `succeeded` = money taken; `open` = the customer can still complete it. */
  state: "succeeded" | "open" | "processing" | "canceled";
  clientSecret: string | null;
  amount: string;
  currency: string;
}

export interface PaymentProvider {
  readonly name: "stripe";

  createIntent(params: {
    amount: string;
    currency: string;
    billId: string;
    patientEmail?: string;
  }): Promise<PaymentIntent>;

  refund(params: { providerRef: string; amount?: string }): Promise<RefundResult>;

  /** Reads an intent's current state from the gateway. */
  retrieveIntent(providerRef: string): Promise<IntentStatus>;

  /** Cancels an open intent so it can no longer be charged. Best-effort for callers. */
  cancelIntent(providerRef: string): Promise<void>;

  /**
   * Verifies the signature against the **raw** body and normalises the payload.
   * Throws if the signature does not match — never trust an unverified webhook.
   */
  verifyWebhook(rawBody: Buffer, signature: string): VerifiedWebhookEvent;
}

/** Thrown when a gateway is called without its credentials configured. */
export class PaymentProviderUnavailable extends Error {
  constructor(provider: string) {
    super(
      `The ${provider} payment provider is not configured. Set its API keys, or take payment as cash.`,
    );
    this.name = "PaymentProviderUnavailable";
  }
}
