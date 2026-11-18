import { Prisma } from "@prisma/client";
import PDFDocument from "pdfkit";
import { prisma, prismaDirect } from "../config/db.js";
import { AppError } from "../utils/AppError.js";
import { logger } from "../utils/logger.js";
import { writeAuditLog } from "../utils/audit.js";
import { dispatchNotification } from "./notification.service.js";
import * as settingsService from "./settings.service.js";
import { BILL_STATUS, assertCanAccessBill, deriveStatus, type Actor } from "./bill.service.js";
import { stripeProvider } from "./payments/stripe.provider.js";
import type {
  IntentStatus,
  PaymentIntent,
  PaymentProvider,
  VerifiedWebhookEvent,
} from "./payments/PaymentProvider.js";
import type {
  CashPaymentInput,
  CreateIntentInput,
  PaymentHistoryInput,
  RefundInput,
} from "@healvista/shared";

const D = Prisma.Decimal;
type Decimal = Prisma.Decimal;
type Tx = Prisma.TransactionClient;

const providers: Record<string, PaymentProvider> = {
  stripe: stripeProvider,
};

function getProvider(name: string): PaymentProvider {
  const provider = providers[name];
  if (!provider) throw new AppError(`Unknown payment provider: ${name}`, 400);
  return provider;
}

/** Payment rows whose money counts towards a bill (net of their own refunds). */
const SETTLED_STATUSES: Array<"SUCCEEDED" | "REFUNDED"> = ["SUCCEEDED", "REFUNDED"];

/**
 * How long an unpaid card intent stays reusable. Re-opening checkout inside this
 * window returns the same intent rather than a second chargeable one.
 */
const INTENT_REUSE_WINDOW_MS = 24 * 60 * 60 * 1000;

/** A bill must be finalised before money can be taken against it. */
function assertPayable(bill: { status: string; balance: Prisma.Decimal }) {
  if (bill.status === BILL_STATUS.DRAFT) {
    throw new AppError("Finalise the bill before taking payment", 409);
  }
  if (bill.status === BILL_STATUS.VOID) {
    throw new AppError("This bill has been voided", 409);
  }
  if (bill.balance.lessThanOrEqualTo(0)) {
    throw new AppError("This bill is already paid in full", 409);
  }
}

/**
 * Serialises every money movement on one bill.
 *
 * A cash payment at the desk, a card webhook and a refund can all land on the same
 * bill at the same moment. Each reads the balance and writes a new one; without a
 * row lock two of them read the same balance and one write silently wins — the
 * classic lost update, here measured in real money.
 */
async function lockBill(tx: Tx, billId: string): Promise<void> {
  await tx.$executeRaw`SELECT 1 FROM bills WHERE id = ${billId} FOR UPDATE`;
}

/**
 * Recomputes `amountPaid`, `balance` and `status` from the bill's payment rows.
 *
 * This is the only place those three fields are written, and it must run inside
 * the transaction that changed the payment rows, after `lockBill`. Recomputing from
 * the rows — rather than adding the latest amount to a stored total — means a bill
 * can never drift from the payments that back it.
 */
async function recomputeBillTotals(tx: Tx, billId: string) {
  const bill = await tx.bill.findUnique({
    where: { id: billId },
    include: { patient: { select: { userId: true, fullName: true } } },
  });
  if (!bill) throw new AppError("Bill not found", 404);

  const settled = await tx.payment.aggregate({
    where: { billId, status: { in: SETTLED_STATUSES } },
    _sum: { amount: true, refundedAmount: true },
  });
  const amountPaid = (settled._sum.amount ?? new D(0)).minus(
    settled._sum.refundedAmount ?? new D(0),
  );

  const updated = await tx.bill.update({
    where: { id: billId },
    data: {
      amountPaid,
      balance: bill.total.minus(amountPaid),
      status: deriveStatus(bill.total, amountPaid, bill.status),
    },
    include: { items: true, payments: true, discount: true },
  });

  return { bill: updated, patient: bill.patient };
}

/** What a settled card payment leaves for after the transaction commits. */
interface Settlement {
  billId: string;
  billNumber: string;
  balance: Decimal;
  amount: Decimal;
  patientUserId: string;
  /** Positive when the bill has now collected more than its total. */
  overpaidBy: Decimal;
}

/**
 * Promotes a card payment to SUCCEEDED and recomputes its bill — idempotently.
 *
 * The conditional `updateMany` is the guard: the webhook and the client-triggered
 * reconcile can both try to settle the same payment, and only the one whose update
 * actually flips the row goes on to touch the bill. Returns null when someone else
 * already settled it.
 */
async function settleSucceededPayment(
  tx: Tx,
  payment: { id: string; billId: string; amount: Decimal },
): Promise<Settlement | null> {
  await lockBill(tx, payment.billId);

  const flipped = await tx.payment.updateMany({
    where: { id: payment.id, status: { notIn: SETTLED_STATUSES } },
    data: { status: "SUCCEEDED" },
  });
  if (flipped.count === 0) return null;

  const { bill, patient } = await recomputeBillTotals(tx, payment.billId);
  return {
    billId: bill.id,
    billNumber: bill.billNumber,
    balance: bill.balance,
    amount: payment.amount,
    patientUserId: patient.userId,
    overpaidBy: bill.amountPaid.minus(bill.total),
  };
}

/**
 * Sets a payment's refunded total to a **cumulative** figure, never adding a delta.
 *
 * Both the in-app refund and the gateway's `charge.refunded` webhook describe the
 * same refund; whichever lands second must be a no-op. Taking the larger of the
 * stored and incoming cumulative totals makes the two paths commute.
 */
async function applyRefundTotal(
  tx: Tx,
  paymentId: string,
  cumulative: Decimal,
  extra: { refundRef?: string | null } = {},
): Promise<boolean> {
  const payment = await tx.payment.findUnique({ where: { id: paymentId } });
  if (!payment) throw new AppError("Payment not found", 404);

  await lockBill(tx, payment.billId);

  const target = D.min(cumulative, payment.amount);
  if (target.lessThanOrEqualTo(payment.refundedAmount)) return false;

  await tx.payment.update({
    where: { id: paymentId },
    data: {
      refundedAmount: target,
      refundedAt: new Date(),
      ...(extra.refundRef ? { refundRef: extra.refundRef } : {}),
      // A refund is only possible on money that was taken, so a row the gateway
      // refunded is settled even if its success webhook has not arrived yet.
      status: target.greaterThanOrEqualTo(payment.amount) ? "REFUNDED" : "SUCCEEDED",
    },
  });
  await recomputeBillTotals(tx, payment.billId);
  return true;
}

/** Side effects of a settlement that must never roll back the money itself. */
async function afterSettlement(settlement: Settlement): Promise<void> {
  if (settlement.overpaidBy.greaterThan(0)) {
    // Two checkouts for the same balance both went through. The money is real, so
    // it is recorded — but an accountant has to refund the excess.
    logger.error(
      {
        billId: settlement.billId,
        billNumber: settlement.billNumber,
        overpaidBy: settlement.overpaidBy.toFixed(2),
      },
      "Bill overpaid — refund the excess from the payment history",
    );
  }
  await notifyReceipt(
    settlement.patientUserId,
    { billNumber: settlement.billNumber, balance: settlement.balance },
    settlement.amount,
  );
}

/**
 * Records a desk payment and recomputes the bill in one transaction.
 *
 * Payability and the balance are re-checked under the bill lock: a card payment can
 * settle between the caller's first read and this write, and checking only outside
 * the transaction is how a bill ends up collecting more than it is owed.
 */
async function recordPayment(params: {
  billId: string;
  amount: Prisma.Decimal;
  method: "CARD" | "CASH" | "BANK_TRANSFER" | "WALLET" | "INSURANCE";
  receivedById?: string | null;
  reference?: string | null;
}) {
  return prismaDirect.$transaction(async (tx) => {
    await lockBill(tx, params.billId);

    const current = await tx.bill.findUnique({
      where: { id: params.billId },
      select: { status: true, balance: true },
    });
    if (!current) throw new AppError("Bill not found", 404);
    assertPayable(current);
    if (params.amount.greaterThan(current.balance)) {
      throw new AppError("Amount exceeds the outstanding balance on this bill", 400);
    }

    const payment = await tx.payment.create({
      data: {
        billId: params.billId,
        amount: params.amount,
        method: params.method,
        status: "SUCCEEDED",
        receivedById: params.receivedById ?? null,
        reference: params.reference ?? null,
      },
    });

    const { bill, patient } = await recomputeBillTotals(tx, params.billId);
    return { payment, bill, patient };
  });
}

/**
 * Looks for a card intent already open on this bill and either hands it back or
 * retires it.
 *
 * Every open intent is independently chargeable. Creating a fresh one each time
 * checkout opens left thousands of them behind — and two of them completed in two
 * tabs charge the patient twice. So: an open intent for the same amount is reused;
 * an open intent for a different amount (the balance moved) is cancelled; one that
 * quietly succeeded is settled now.
 */
async function reuseOrRetireOpenIntents(
  provider: PaymentProvider,
  billId: string,
  amount: Decimal,
): Promise<PaymentIntent | null> {
  const open = await prisma.payment.findMany({
    where: {
      billId,
      provider: provider.name,
      status: "PENDING",
      providerRef: { not: null },
      createdAt: { gte: new Date(Date.now() - INTENT_REUSE_WINDOW_MS) },
    },
    orderBy: { createdAt: "desc" },
    take: 5,
  });

  let reusable: PaymentIntent | null = null;

  for (const row of open) {
    let intent: IntentStatus;
    try {
      intent = await provider.retrieveIntent(row.providerRef!);
    } catch (err) {
      logger.warn({ err, paymentId: row.id }, "Could not read back an open payment intent");
      continue;
    }

    if (intent.state === "succeeded") {
      const settlement = await prismaDirect.$transaction((tx) => settleSucceededPayment(tx, row));
      if (settlement) await afterSettlement(settlement);
      throw new AppError(
        "A card payment for this bill has just gone through. Refresh to see the updated balance.",
        409,
      );
    }

    if (intent.state === "processing") {
      throw new AppError(
        "A card payment for this bill is still processing. Try again in a minute.",
        409,
      );
    }

    if (intent.state === "open" && !reusable && intent.clientSecret && row.amount.equals(amount)) {
      reusable = {
        providerRef: intent.providerRef,
        clientSecret: intent.clientSecret,
        amount: amount.toFixed(2),
        currency: intent.currency,
      };
      continue;
    }

    if (intent.state === "open") {
      await provider.cancelIntent(row.providerRef!).catch((err) => {
        logger.warn({ err, paymentId: row.id }, "Could not cancel a superseded payment intent");
      });
    }
    await prisma.payment.updateMany({
      where: { id: row.id, status: "PENDING" },
      data: { status: "FAILED" },
    });
  }

  return reusable;
}

export async function createIntent(input: CreateIntentInput, actor: Actor) {
  await assertCanAccessBill(input.billId, actor);

  const bill = await prisma.bill.findUnique({
    where: { id: input.billId },
    include: { patient: { select: { user: { select: { email: true } } } } },
  });
  if (!bill) throw new AppError("Bill not found", 404);
  assertPayable(bill);

  const amount = input.amount ? new D(input.amount) : bill.balance;
  if (amount.lessThanOrEqualTo(0)) throw new AppError("Amount must be positive", 400);
  if (amount.greaterThan(bill.balance)) {
    throw new AppError("Amount exceeds the outstanding balance on this bill", 400);
  }

  const provider = getProvider(input.provider);

  const reused = await reuseOrRetireOpenIntents(provider, bill.id, amount);
  if (reused) {
    logger.info(
      { billId: bill.id, providerRef: reused.providerRef },
      "Reusing open payment intent",
    );
    return reused;
  }

  const settings = (await settingsService.get()) as { currency: string };

  logger.info(
    {
      billId: bill.id,
      billNumber: bill.billNumber,
      provider: provider.name,
      amount: amount.toString(),
      currency: settings.currency,
    },
    "Creating payment intent",
  );

  let intent: PaymentIntent;
  try {
    intent = await provider.createIntent({
      amount: amount.toFixed(2),
      currency: settings.currency,
      billId: bill.id,
      patientEmail: bill.patient.user?.email,
    });
  } catch (err) {
    // Logged with the full stack here so an operator can see exactly which bill,
    // provider and amount failed — then rethrown for the central handler to map
    // into a meaningful response (unconfigured gateway → 503, Stripe SDK error →
    // its own status).
    logger.error(
      {
        err,
        billId: bill.id,
        billNumber: bill.billNumber,
        provider: provider.name,
        amount: amount.toString(),
      },
      "Payment intent creation failed",
    );
    throw err;
  }

  logger.info(
    { billId: bill.id, providerRef: intent.providerRef, amount: amount.toString() },
    "Payment intent created",
  );

  // Recorded as PENDING now; the webhook (or a reconcile that reads the intent back
  // from the gateway) is what promotes it to SUCCEEDED. The client returning
  // "success" is a hint, never the source of truth.
  await prisma.payment.create({
    data: {
      billId: bill.id,
      amount,
      method: "CARD",
      status: "PENDING",
      provider: provider.name,
      providerRef: intent.providerRef,
    },
  });

  await writeAuditLog({
    actorUserId: actor.userId,
    action: "PAYMENT_INTENT_CREATED",
    targetType: "bill",
    targetId: bill.id,
    metadata: { provider: provider.name, amount: amount.toString() },
  });

  return intent;
}

/**
 * Cash taken at the desk. `receivedById` is mandatory and comes from the session,
 * never the request body — an untraceable cash payment is an accounting hole.
 */
export async function recordCashPayment(input: CashPaymentInput, actor: Actor) {
  const bill = await prisma.bill.findUnique({ where: { id: input.billId } });
  if (!bill) throw new AppError("Bill not found", 404);
  assertPayable(bill);

  const amount = new D(input.amount);
  if (amount.lessThanOrEqualTo(0)) throw new AppError("Amount must be positive", 400);
  if (amount.greaterThan(bill.balance)) {
    throw new AppError("Amount exceeds the outstanding balance on this bill", 400);
  }

  const {
    payment,
    bill: updated,
    patient,
  } = await recordPayment({
    billId: input.billId,
    amount,
    method: "CASH",
    receivedById: actor.userId,
    reference: input.reference ?? null,
  });

  await writeAuditLog({
    actorUserId: actor.userId,
    action: "PAYMENT_CASH_RECEIVED",
    targetType: "payment",
    targetId: payment.id,
    metadata: {
      billId: input.billId,
      amount: amount.toString(),
      balanceAfter: updated.balance.toString(),
    },
  });

  await notifyReceipt(patient.userId, updated, amount);

  return { payment, bill: updated };
}

async function notifyReceipt(
  userId: string,
  bill: { billNumber: string; balance: Prisma.Decimal },
  amount: Prisma.Decimal,
) {
  try {
    await dispatchNotification({
      userId,
      type: "PAYMENT_RECEIPT",
      title: "Payment received",
      message: `We received ${amount.toFixed(2)} for invoice ${bill.billNumber}. Outstanding balance: ${bill.balance.toFixed(2)}.`,
      data: {
        amount: amount.toFixed(2),
        description: `Invoice ${bill.billNumber}`,
        receiptUrl: "",
      },
    });
  } catch (err) {
    // A notification failure must never roll back a recorded payment.
    logger.error({ err, userId }, "[payment] receipt notification failed");
  }
}

type WebhookStatus =
  | "duplicate"
  | "ignored"
  | "unknown_payment"
  | "failed_recorded"
  | "settled"
  | "already_settled"
  | "stale_event"
  | "refund_recorded";

/** Applies one verified event inside the transaction that also records it. */
async function applyWebhookEvent(
  tx: Tx,
  providerName: string,
  event: VerifiedWebhookEvent,
): Promise<{ status: WebhookStatus; settlement?: Settlement }> {
  if (event.type === "ignored" || !event.providerRef) return { status: "ignored" };

  const payment = await tx.payment.findUnique({
    where: { provider_providerRef: { provider: providerName, providerRef: event.providerRef } },
  });
  if (!payment) return { status: "unknown_payment" };

  switch (event.type) {
    case "payment_failed":
    case "payment_canceled": {
      // Events arrive out of order. A late failure for an earlier declined attempt
      // must never un-settle a payment that has since succeeded — so only an
      // unsettled row can fail.
      const failed = await tx.payment.updateMany({
        where: { id: payment.id, status: "PENDING" },
        data: { status: "FAILED" },
      });
      return { status: failed.count > 0 ? "failed_recorded" : "stale_event" };
    }

    case "payment_succeeded": {
      const settlement = await settleSucceededPayment(tx, payment);
      return settlement ? { status: "settled", settlement } : { status: "already_settled" };
    }

    case "refunded": {
      // A refund issued from the gateway's own dashboard reaches billing only
      // through here. A refund made in the app arrives too, and is a no-op because
      // the cumulative total already matches.
      const changed = await applyRefundTotal(tx, payment.id, new D(event.amount ?? "0"));
      return { status: changed ? "refund_recorded" : "stale_event" };
    }

    default:
      return { status: "ignored" };
  }
}

/**
 * Handles a verified webhook exactly once.
 *
 * The `webhook_events` row is written **in the same transaction** as the work it
 * guards. If settling throws — a dropped connection, a lock timeout — the row rolls
 * back with it and the provider's retry is processed afresh. Writing it first, in
 * its own statement, turned every transient failure into a permanently PENDING
 * payment: the retry was waved through as a "duplicate".
 *
 * Concurrent deliveries are arbitrated by the unique (provider, eventId) index: the
 * second insert blocks until the first transaction commits, then fails with P2002.
 */
export async function handleWebhook(providerName: string, rawBody: Buffer, signature: string) {
  const provider = getProvider(providerName);
  const event = provider.verifyWebhook(rawBody, signature);

  let outcome: { status: WebhookStatus; settlement?: Settlement };
  try {
    outcome = await prismaDirect.$transaction(async (tx) => {
      await tx.webhookEvent.create({
        data: { provider: provider.name, eventId: event.eventId, eventType: event.type },
      });
      return applyWebhookEvent(tx, provider.name, event);
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { status: "duplicate" as const, eventId: event.eventId };
    }
    throw err;
  }

  if (outcome.settlement) await afterSettlement(outcome.settlement);
  return { status: outcome.status, eventId: event.eventId };
}

/**
 * Asks the gateway what actually happened to a card payment and records it.
 *
 * The webhook is the primary path, but it can be late (a sleeping host), missing
 * (an endpoint misconfigured) or never sent (local development without the CLI).
 * Reading the intent back from the gateway — never trusting the browser's word —
 * closes that gap. Safe to run any number of times, concurrently with the webhook.
 */
export async function reconcilePayment(paymentId: string) {
  const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!payment) throw new AppError("Payment not found", 404);
  if (!payment.provider || !payment.providerRef) {
    return { paymentId, status: payment.status, changed: false };
  }
  if (payment.status !== "PENDING" && payment.status !== "FAILED") {
    return { paymentId, status: payment.status, changed: false };
  }

  const intent = await getProvider(payment.provider).retrieveIntent(payment.providerRef);

  if (intent.state === "succeeded") {
    const settlement = await prismaDirect.$transaction((tx) => settleSucceededPayment(tx, payment));
    if (settlement) await afterSettlement(settlement);
    return { paymentId, status: "SUCCEEDED" as const, changed: Boolean(settlement) };
  }

  if (intent.state === "canceled" && payment.status === "PENDING") {
    const failed = await prisma.payment.updateMany({
      where: { id: payment.id, status: "PENDING" },
      data: { status: "FAILED" },
    });
    return { paymentId, status: "FAILED" as const, changed: failed.count > 0 };
  }

  return { paymentId, status: payment.status, changed: false };
}

/**
 * Client-triggered reconcile, called right after checkout reports success so the
 * bill updates in seconds even when the webhook is delayed. Scoped to callers who
 * can see the bill.
 */
export async function syncIntent(providerRef: string, actor: Actor) {
  const payment = await prisma.payment.findFirst({
    where: { providerRef },
    select: { id: true, billId: true },
  });
  if (!payment) throw new AppError("Payment not found", 404);
  await assertCanAccessBill(payment.billId, actor);

  const result = await reconcilePayment(payment.id);
  const bill = await prisma.bill.findUnique({
    where: { id: payment.billId },
    select: { id: true, status: true, balance: true, amountPaid: true },
  });
  return { payment: result, bill };
}

export async function refundPayment(paymentId: string, input: RefundInput, actor: Actor) {
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: { bill: true },
  });
  if (!payment) throw new AppError("Payment not found", 404);
  if (payment.status !== "SUCCEEDED") {
    throw new AppError("Only a settled payment can be refunded", 409);
  }

  const refundable = payment.amount.minus(payment.refundedAmount);
  if (refundable.lessThanOrEqualTo(0)) {
    throw new AppError("This payment has already been fully refunded", 409);
  }

  const amount = input.amount ? new D(input.amount) : refundable;
  if (amount.lessThanOrEqualTo(0)) throw new AppError("Refund amount must be positive", 400);
  if (amount.greaterThan(refundable)) {
    throw new AppError("Refund exceeds the refundable amount on this payment", 400);
  }

  // Card refunds go back through the gateway; cash is handed over at the desk and
  // only recorded here.
  let refundRef: string | null = null;
  if (payment.provider && payment.providerRef) {
    const result = await getProvider(payment.provider).refund({
      providerRef: payment.providerRef,
      amount: amount.toFixed(2),
    });
    refundRef = result.refundRef;
  }

  // The cumulative target, not a delta: the gateway's `charge.refunded` webhook may
  // already have recorded this very refund by the time this transaction runs.
  const cumulative = payment.refundedAmount.plus(amount);
  const updated = await prismaDirect.$transaction(async (tx) => {
    await applyRefundTotal(tx, paymentId, cumulative, { refundRef });
    return tx.bill.findUniqueOrThrow({
      where: { id: payment.billId },
      include: { payments: true },
    });
  });

  await writeAuditLog({
    actorUserId: actor.userId,
    action: "PAYMENT_REFUNDED",
    targetType: "payment",
    targetId: paymentId,
    metadata: {
      billId: payment.billId,
      amount: amount.toString(),
      reason: input.reason,
      refundRef,
    },
  });

  return updated;
}

const PAYMENT_STAFF_ROLES = ["ACCOUNTANT", "RECEPTIONIST", "ADMIN"];

export async function getPaymentHistory(filters: PaymentHistoryInput, actor: Actor) {
  const where: Prisma.PaymentWhereInput = {};

  // Patients see their own payments only; the requested patientId cannot widen that.
  if (!PAYMENT_STAFF_ROLES.includes(actor.role)) {
    if (actor.role !== "PATIENT") throw new AppError("Not authorised to view payments", 403);
    const patient = await prisma.patient.findUnique({
      where: { userId: actor.userId },
      select: { id: true },
    });
    if (!patient) throw new AppError("Patient record not found", 404);
    where.bill = { patientId: patient.id };
  } else if (filters.patientId) {
    where.bill = { patientId: filters.patientId };
  }

  if (filters.billId) where.billId = filters.billId;
  if (filters.method) where.method = filters.method;
  if (filters.includeFailed !== "true") where.status = { not: "FAILED" };
  if (filters.fromDate || filters.toDate) {
    where.createdAt = {};
    if (filters.fromDate) where.createdAt.gte = filters.fromDate;
    if (filters.toDate) where.createdAt.lte = filters.toDate;
  }

  const [payments, total] = await Promise.all([
    prisma.payment.findMany({
      where,
      include: {
        bill: {
          select: {
            id: true,
            billNumber: true,
            patient: { select: { id: true, fullName: true, mrn: true } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      skip: (filters.page - 1) * filters.limit,
      take: filters.limit,
    }),
    prisma.payment.count({ where }),
  ]);

  // Resolve cashier names in one query rather than N.
  const cashierIds = [...new Set(payments.map((p) => p.receivedById).filter(Boolean))] as string[];
  const cashiers = cashierIds.length
    ? await prisma.user.findMany({
        where: { id: { in: cashierIds } },
        select: { id: true, email: true },
      })
    : [];
  const cashierById = new Map(cashiers.map((c) => [c.id, c.email]));

  return {
    payments: payments.map((p) => ({
      ...p,
      receivedByEmail: p.receivedById ? (cashierById.get(p.receivedById) ?? null) : null,
    })),
    total,
    page: filters.page,
    limit: filters.limit,
  };
}

export async function generateReceiptPdf(paymentId: string, actor: Actor) {
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: {
      bill: { include: { patient: { select: { fullName: true, mrn: true } } } },
    },
  });
  if (!payment) throw new AppError("Payment not found", 404);
  await assertCanAccessBill(payment.billId, actor);

  const settings = (await settingsService.get()) as { name: string; currency: string };
  const doc = new PDFDocument({ size: "A4", margin: 50 });

  doc.fontSize(20).text(settings.name, { align: "center" });
  doc.moveDown(0.5);
  doc.fontSize(14).text("Payment Receipt", { align: "center" });
  doc.moveDown(1.5);

  const line = (label: string, value: string) => {
    doc.fontSize(10).fillColor("#666").text(label, { continued: true });
    doc.fillColor("#000").text(`  ${value}`);
    doc.moveDown(0.4);
  };

  line("Receipt no", payment.id);
  line("Invoice", payment.bill.billNumber);
  line("Patient", `${payment.bill.patient.fullName} (MRN ${payment.bill.patient.mrn})`);
  line("Date", payment.createdAt.toISOString().replace("T", " ").slice(0, 16));
  line("Method", payment.method);
  if (payment.reference) line("Reference", payment.reference);
  doc.moveDown(0.5);
  line("Amount paid", `${settings.currency} ${payment.amount.toFixed(2)}`);
  if (payment.refundedAmount.greaterThan(0)) {
    line("Refunded", `${settings.currency} ${payment.refundedAmount.toFixed(2)}`);
  }
  line("Invoice balance", `${settings.currency} ${payment.bill.balance.toFixed(2)}`);

  doc.end();
  return { doc, filename: `receipt-${payment.id}.pdf` };
}
