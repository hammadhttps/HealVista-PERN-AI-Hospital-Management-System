import { describe, it, expect, vi, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "../config/db.js";

vi.mock("../config/db", () => {
  const prisma = {
    bill: { findUnique: vi.fn(), update: vi.fn() },
    payment: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      aggregate: vi.fn(),
    },
    patient: { findUnique: vi.fn() },
    user: { findMany: vi.fn() },
    webhookEvent: { create: vi.fn() },
    $transaction: vi.fn(),
  };
  return { prisma, prismaDirect: prisma };
});

vi.mock("../config/redis", () => ({ redis: null, getCached: vi.fn(), setCached: vi.fn() }));
vi.mock("../utils/audit", () => ({ writeAuditLog: vi.fn() }));
vi.mock("./notification.service", () => ({ dispatchNotification: vi.fn() }));
vi.mock("./settings.service", () => ({
  get: vi.fn().mockResolvedValue({ currency: "USD", taxPercentage: new Prisma.Decimal(0) }),
}));
vi.mock("./bill.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./bill.service.js")>();
  return { ...actual, assertCanAccessBill: vi.fn() };
});

// The gateway SDKs must never be reached from a test.
const verifyWebhook = vi.fn();
vi.mock("./payments/stripe.provider", () => ({
  stripeProvider: {
    name: "stripe",
    createIntent: vi.fn(),
    refund: vi.fn(),
    retrieveIntent: vi.fn(),
    cancelIntent: vi.fn(),
    verifyWebhook: (...args: unknown[]) => verifyWebhook(...args),
  },
}));

const D = Prisma.Decimal;

function p2002() {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "6.0.0",
  });
}

/**
 * A fake interactive-transaction client. Every method is a fresh mock so each test
 * can assert exactly what ran inside the transaction.
 */
function makeTx(over: { bill?: Record<string, unknown>; aggregate?: [string, string] } = {}) {
  const [paid, refunded] = over.aggregate ?? ["50.00", "0"];
  return {
    $executeRaw: vi.fn().mockResolvedValue(1),
    webhookEvent: { create: vi.fn().mockResolvedValue({ id: "we-1" }) },
    payment: {
      create: vi.fn().mockResolvedValue({ id: "pay-new" }),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      aggregate: vi.fn().mockResolvedValue({
        _sum: { amount: new D(paid), refundedAmount: new D(refunded) },
      }),
    },
    bill: {
      findUnique: vi.fn().mockResolvedValue({
        id: "bill-1",
        total: new D("50.00"),
        balance: new D("50.00"),
        status: "finalised",
        billNumber: "INV-1",
        patient: { userId: "u1", fullName: "Pat" },
        ...over.bill,
      }),
      findUniqueOrThrow: vi.fn().mockResolvedValue({ id: "bill-1", payments: [] }),
      update: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "bill-1",
        billNumber: "INV-1",
        total: new D("50.00"),
        ...data,
      })),
    },
  };
}

type FakeTx = ReturnType<typeof makeTx>;

/** Routes `$transaction(fn)` through the given fake client. */
function useTx(tx: FakeTx) {
  vi.mocked(prisma.$transaction).mockImplementation(async (fn: never) =>
    (fn as unknown as (t: FakeTx) => unknown)(tx),
  );
}

const pendingPayment = (over: Record<string, unknown> = {}) => ({
  id: "pay-1",
  billId: "bill-1",
  status: "PENDING",
  amount: new D("50.00"),
  refundedAmount: new D("0"),
  provider: "stripe",
  providerRef: "pi_123",
  ...over,
});

describe("webhook handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyWebhook.mockReturnValue({
      eventId: "evt_123",
      type: "payment_succeeded",
      providerRef: "pi_123",
      amount: "50.00",
    });
  });

  it("records the event and settles the payment in one transaction", async () => {
    const tx = makeTx();
    tx.payment.findUnique.mockResolvedValue(pendingPayment());
    useTx(tx);

    const { handleWebhook } = await import("./payment.service.js");
    const result = await handleWebhook("stripe", Buffer.from("{}"), "sig");

    expect(result.status).toBe("settled");
    expect(tx.webhookEvent.create).toHaveBeenCalledTimes(1);
    expect(tx.$executeRaw).toHaveBeenCalled(); // bill row locked
    expect(tx.bill.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "paid" }) }),
    );
    // Nothing is written outside the transaction.
    expect(prisma.webhookEvent.create).not.toHaveBeenCalled();
  });

  it("answers a replayed event as a duplicate", async () => {
    // The unique constraint on (provider, eventId) is the guarantee — a prior
    // SELECT would let two concurrent retries both through.
    vi.mocked(prisma.$transaction).mockRejectedValue(p2002());

    const { handleWebhook } = await import("./payment.service.js");
    const result = await handleWebhook("stripe", Buffer.from("{}"), "sig");

    expect(result.status).toBe("duplicate");
  });

  it("fails the delivery when settling throws, so the provider retries it", async () => {
    // Regression: the event row used to be committed before settling, so a
    // transient failure made every retry a "duplicate" and the payment stayed
    // PENDING forever. Now the error escapes and the row rolls back with it.
    const tx = makeTx();
    tx.payment.findUnique.mockResolvedValue(pendingPayment());
    tx.bill.update.mockRejectedValue(new Error("connection reset"));
    useTx(tx);

    const { handleWebhook } = await import("./payment.service.js");
    await expect(handleWebhook("stripe", Buffer.from("{}"), "sig")).rejects.toThrow(
      "connection reset",
    );
  });

  it("does not double-settle a payment someone else already settled", async () => {
    const tx = makeTx();
    tx.payment.findUnique.mockResolvedValue(pendingPayment({ status: "SUCCEEDED" }));
    tx.payment.updateMany.mockResolvedValue({ count: 0 });
    useTx(tx);

    const { handleWebhook } = await import("./payment.service.js");
    const result = await handleWebhook("stripe", Buffer.from("{}"), "sig");

    expect(result.status).toBe("already_settled");
    expect(tx.bill.update).not.toHaveBeenCalled();
  });

  it("records a failed attempt without altering the balance", async () => {
    verifyWebhook.mockReturnValue({
      eventId: "evt_fail",
      type: "payment_failed",
      providerRef: "pi_123",
      amount: "50.00",
    });
    const tx = makeTx();
    tx.payment.findUnique.mockResolvedValue(pendingPayment());
    useTx(tx);

    const { handleWebhook } = await import("./payment.service.js");
    const result = await handleWebhook("stripe", Buffer.from("{}"), "sig");

    expect(result.status).toBe("failed_recorded");
    expect(tx.payment.updateMany).toHaveBeenCalledWith({
      where: { id: "pay-1", status: "PENDING" },
      data: { status: "FAILED" },
    });
    expect(tx.bill.update).not.toHaveBeenCalled();
  });

  it("never un-settles a payment when a late failure event arrives", async () => {
    verifyWebhook.mockReturnValue({
      eventId: "evt_late",
      type: "payment_failed",
      providerRef: "pi_123",
      amount: "50.00",
    });
    const tx = makeTx();
    tx.payment.findUnique.mockResolvedValue(pendingPayment({ status: "SUCCEEDED" }));
    tx.payment.updateMany.mockResolvedValue({ count: 0 }); // guarded on PENDING
    useTx(tx);

    const { handleWebhook } = await import("./payment.service.js");
    const result = await handleWebhook("stripe", Buffer.from("{}"), "sig");

    expect(result.status).toBe("stale_event");
  });

  it("retires a cancelled intent", async () => {
    verifyWebhook.mockReturnValue({
      eventId: "evt_cancel",
      type: "payment_canceled",
      providerRef: "pi_123",
      amount: "50.00",
    });
    const tx = makeTx();
    tx.payment.findUnique.mockResolvedValue(pendingPayment());
    useTx(tx);

    const { handleWebhook } = await import("./payment.service.js");
    const result = await handleWebhook("stripe", Buffer.from("{}"), "sig");

    expect(result.status).toBe("failed_recorded");
  });

  it("applies a dashboard refund as a cumulative total", async () => {
    verifyWebhook.mockReturnValue({
      eventId: "evt_refund",
      type: "refunded",
      providerRef: "pi_123",
      amount: "20.00",
    });
    const tx = makeTx({ aggregate: ["50.00", "20.00"] });
    tx.payment.findUnique.mockResolvedValue(pendingPayment({ status: "SUCCEEDED" }));
    useTx(tx);

    const { handleWebhook } = await import("./payment.service.js");
    const result = await handleWebhook("stripe", Buffer.from("{}"), "sig");

    expect(result.status).toBe("refund_recorded");
    const update = tx.payment.update.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(String(update.data.refundedAmount)).toBe("20");
    expect(update.data.status).toBe("SUCCEEDED"); // partial refund
    expect(tx.bill.update).toHaveBeenCalled();
  });

  it("treats a refund event for an already-recorded refund as a no-op", async () => {
    verifyWebhook.mockReturnValue({
      eventId: "evt_refund_again",
      type: "refunded",
      providerRef: "pi_123",
      amount: "20.00",
    });
    const tx = makeTx();
    tx.payment.findUnique.mockResolvedValue(
      pendingPayment({ status: "SUCCEEDED", refundedAmount: new D("20.00") }),
    );
    useTx(tx);

    const { handleWebhook } = await import("./payment.service.js");
    const result = await handleWebhook("stripe", Buffer.from("{}"), "sig");

    expect(result.status).toBe("stale_event");
    expect(tx.payment.update).not.toHaveBeenCalled();
  });

  it("ignores an event type billing does not act on", async () => {
    verifyWebhook.mockReturnValue({
      eventId: "evt_other",
      type: "ignored",
      providerRef: null,
      amount: null,
    });
    const tx = makeTx();
    useTx(tx);

    const { handleWebhook } = await import("./payment.service.js");
    const result = await handleWebhook("stripe", Buffer.from("{}"), "sig");

    expect(result.status).toBe("ignored");
    expect(tx.payment.findUnique).not.toHaveBeenCalled();
  });
});

describe("card checkout intents", () => {
  const actor = { userId: "u1", role: "PATIENT" };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.bill.findUnique).mockResolvedValue({
      id: "bill-1",
      billNumber: "INV-1",
      status: "finalised",
      balance: new D("50.00"),
      patient: { user: { email: "p@example.com" } },
    } as never);
  });

  it("reuses an open intent for the same amount instead of opening a second one", async () => {
    vi.mocked(prisma.payment.findMany).mockResolvedValue([pendingPayment()] as never);
    const { stripeProvider } = await import("./payments/stripe.provider.js");
    vi.mocked(stripeProvider.retrieveIntent).mockResolvedValue({
      providerRef: "pi_123",
      state: "open",
      clientSecret: "pi_123_secret",
      amount: "50.00",
      currency: "USD",
    });

    const { createIntent } = await import("./payment.service.js");
    const intent = await createIntent({ billId: "bill-1", provider: "stripe" }, actor);

    expect(intent.clientSecret).toBe("pi_123_secret");
    expect(stripeProvider.createIntent).not.toHaveBeenCalled();
    expect(prisma.payment.create).not.toHaveBeenCalled();
  });

  it("cancels an open intent whose amount no longer matches, then opens a fresh one", async () => {
    vi.mocked(prisma.payment.findMany).mockResolvedValue([
      pendingPayment({ amount: new D("80.00") }),
    ] as never);
    const { stripeProvider } = await import("./payments/stripe.provider.js");
    vi.mocked(stripeProvider.retrieveIntent).mockResolvedValue({
      providerRef: "pi_123",
      state: "open",
      clientSecret: "pi_123_secret",
      amount: "80.00",
      currency: "USD",
    });
    vi.mocked(stripeProvider.cancelIntent).mockResolvedValue();
    vi.mocked(stripeProvider.createIntent).mockResolvedValue({
      providerRef: "pi_new",
      clientSecret: "pi_new_secret",
      amount: "50.00",
      currency: "USD",
    });
    vi.mocked(prisma.payment.updateMany).mockResolvedValue({ count: 1 } as never);

    const { createIntent } = await import("./payment.service.js");
    const intent = await createIntent({ billId: "bill-1", provider: "stripe" }, actor);

    expect(stripeProvider.cancelIntent).toHaveBeenCalledWith("pi_123");
    expect(prisma.payment.updateMany).toHaveBeenCalledWith({
      where: { id: "pay-1", status: "PENDING" },
      data: { status: "FAILED" },
    });
    expect(intent.providerRef).toBe("pi_new");
  });

  it("settles an intent that quietly succeeded and refuses a second checkout", async () => {
    vi.mocked(prisma.payment.findMany).mockResolvedValue([pendingPayment()] as never);
    const { stripeProvider } = await import("./payments/stripe.provider.js");
    vi.mocked(stripeProvider.retrieveIntent).mockResolvedValue({
      providerRef: "pi_123",
      state: "succeeded",
      clientSecret: null,
      amount: "50.00",
      currency: "USD",
    });
    const tx = makeTx();
    useTx(tx);

    const { createIntent } = await import("./payment.service.js");
    await expect(createIntent({ billId: "bill-1", provider: "stripe" }, actor)).rejects.toThrow(
      "just gone through",
    );
    expect(tx.payment.updateMany).toHaveBeenCalled();
    expect(stripeProvider.createIntent).not.toHaveBeenCalled();
  });
});

describe("reconcile", () => {
  beforeEach(() => vi.clearAllMocks());

  it("settles a pending payment the gateway reports as succeeded", async () => {
    vi.mocked(prisma.payment.findUnique).mockResolvedValue(pendingPayment() as never);
    const { stripeProvider } = await import("./payments/stripe.provider.js");
    vi.mocked(stripeProvider.retrieveIntent).mockResolvedValue({
      providerRef: "pi_123",
      state: "succeeded",
      clientSecret: null,
      amount: "50.00",
      currency: "USD",
    });
    const tx = makeTx();
    useTx(tx);

    const { reconcilePayment } = await import("./payment.service.js");
    const result = await reconcilePayment("pay-1");

    expect(result).toEqual({ paymentId: "pay-1", status: "SUCCEEDED", changed: true });
    expect(tx.bill.update).toHaveBeenCalled();
  });

  it("leaves an open intent alone", async () => {
    vi.mocked(prisma.payment.findUnique).mockResolvedValue(pendingPayment() as never);
    const { stripeProvider } = await import("./payments/stripe.provider.js");
    vi.mocked(stripeProvider.retrieveIntent).mockResolvedValue({
      providerRef: "pi_123",
      state: "open",
      clientSecret: "s",
      amount: "50.00",
      currency: "USD",
    });

    const { reconcilePayment } = await import("./payment.service.js");
    const result = await reconcilePayment("pay-1");

    expect(result.changed).toBe(false);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("cash payments", () => {
  beforeEach(() => vi.clearAllMocks());

  it("refuses to take cash against a draft bill", async () => {
    vi.mocked(prisma.bill.findUnique).mockResolvedValue({
      id: "bill-1",
      status: "draft",
      balance: new D("100.00"),
    } as never);

    const { recordCashPayment } = await import("./payment.service.js");
    await expect(
      recordCashPayment(
        { billId: "bill-1", amount: "50.00" },
        { userId: "u1", role: "RECEPTIONIST" },
      ),
    ).rejects.toThrow("Finalise the bill");
  });

  it("refuses an amount larger than the outstanding balance", async () => {
    vi.mocked(prisma.bill.findUnique).mockResolvedValue({
      id: "bill-1",
      status: "finalised",
      balance: new D("40.00"),
    } as never);

    const { recordCashPayment } = await import("./payment.service.js");
    await expect(
      recordCashPayment(
        { billId: "bill-1", amount: "50.00" },
        { userId: "u1", role: "RECEPTIONIST" },
      ),
    ).rejects.toThrow("exceeds the outstanding balance");
  });

  it("refuses payment against an already-paid bill", async () => {
    vi.mocked(prisma.bill.findUnique).mockResolvedValue({
      id: "bill-1",
      status: "paid",
      balance: new D("0.00"),
    } as never);

    const { recordCashPayment } = await import("./payment.service.js");
    await expect(
      recordCashPayment(
        { billId: "bill-1", amount: "10.00" },
        { userId: "u1", role: "RECEPTIONIST" },
      ),
    ).rejects.toThrow("already paid in full");
  });

  it("re-checks the balance under the bill lock", async () => {
    // A card payment settled between the first read (balance 50) and the
    // transaction (balance now 10): the cash must be refused, not overpay the bill.
    vi.mocked(prisma.bill.findUnique).mockResolvedValue({
      id: "bill-1",
      status: "finalised",
      balance: new D("50.00"),
    } as never);
    const tx = makeTx({ bill: { balance: new D("10.00"), status: "partially_paid" } });
    useTx(tx);

    const { recordCashPayment } = await import("./payment.service.js");
    await expect(
      recordCashPayment(
        { billId: "bill-1", amount: "50.00" },
        { userId: "u1", role: "RECEPTIONIST" },
      ),
    ).rejects.toThrow("exceeds the outstanding balance");
    expect(tx.$executeRaw).toHaveBeenCalled();
    expect(tx.payment.create).not.toHaveBeenCalled();
  });

  it("records cash and recomputes the bill from its payment rows", async () => {
    vi.mocked(prisma.bill.findUnique).mockResolvedValue({
      id: "bill-1",
      status: "finalised",
      balance: new D("50.00"),
    } as never);
    const tx = makeTx({ aggregate: ["20.00", "0"] });
    useTx(tx);

    const { recordCashPayment } = await import("./payment.service.js");
    const { bill } = await recordCashPayment(
      { billId: "bill-1", amount: "20.00" },
      { userId: "u1", role: "RECEPTIONIST" },
    );

    expect(String(bill.balance)).toBe("30");
    expect(bill.status).toBe("partially_paid");
  });
});

describe("refunds", () => {
  const actor = { userId: "acc1", role: "ACCOUNTANT" };
  const settledPayment = (over: Partial<Record<string, unknown>> = {}) =>
    ({
      ...pendingPayment({ status: "SUCCEEDED" }),
      bill: { total: new D("50.00"), status: "finalised" },
      ...over,
    }) as never;

  beforeEach(() => vi.clearAllMocks());

  it("refuses to refund a payment that never settled", async () => {
    vi.mocked(prisma.payment.findUnique).mockResolvedValue(settledPayment({ status: "PENDING" }));

    const { refundPayment } = await import("./payment.service.js");
    await expect(
      refundPayment("pay-1", { amount: "10.00", reason: "overcharged" }, actor),
    ).rejects.toThrow("settled payment");
  });

  it("refuses a second refund after the payment is fully refunded", async () => {
    vi.mocked(prisma.payment.findUnique).mockResolvedValue(
      settledPayment({ refundedAmount: new D("50.00") }),
    );

    const { refundPayment } = await import("./payment.service.js");
    await expect(refundPayment("pay-1", { reason: "already refunded" }, actor)).rejects.toThrow(
      "already been fully refunded",
    );
  });

  it("refuses an amount larger than what remains refundable", async () => {
    vi.mocked(prisma.payment.findUnique).mockResolvedValue(
      settledPayment({ refundedAmount: new D("40.00") }),
    );

    const { refundPayment } = await import("./payment.service.js");
    await expect(refundPayment("pay-1", { amount: "20.00", reason: "x" }, actor)).rejects.toThrow(
      "exceeds the refundable amount",
    );
  });

  it("sends card refunds back through the gateway and audits them", async () => {
    vi.mocked(prisma.payment.findUnique).mockResolvedValue(settledPayment());
    const { stripeProvider } = await import("./payments/stripe.provider.js");
    vi.mocked(stripeProvider.refund).mockResolvedValue({ refundRef: "re_1", amount: "50.00" });
    const tx = makeTx({ aggregate: ["50.00", "50.00"] });
    tx.payment.findUnique.mockResolvedValue(pendingPayment({ status: "SUCCEEDED" }));
    useTx(tx);

    const { refundPayment } = await import("./payment.service.js");
    const { writeAuditLog } = await import("../utils/audit.js");
    await refundPayment("pay-1", { reason: "patient dispute" }, actor);

    expect(stripeProvider.refund).toHaveBeenCalledWith({
      providerRef: "pi_123",
      amount: "50.00",
    });
    const update = tx.payment.update.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(update.data.status).toBe("REFUNDED");
    expect(update.data.refundRef).toBe("re_1");
    expect(writeAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "PAYMENT_REFUNDED",
        targetId: "pay-1",
        actorUserId: "acc1",
      }),
    );
  });

  it("does not double-count a refund the webhook already recorded", async () => {
    // The gateway's charge.refunded webhook can land before this transaction runs.
    vi.mocked(prisma.payment.findUnique).mockResolvedValue(settledPayment());
    const { stripeProvider } = await import("./payments/stripe.provider.js");
    vi.mocked(stripeProvider.refund).mockResolvedValue({ refundRef: "re_1", amount: "20.00" });
    const tx = makeTx();
    tx.payment.findUnique.mockResolvedValue(
      pendingPayment({ status: "SUCCEEDED", refundedAmount: new D("20.00") }),
    );
    useTx(tx);

    const { refundPayment } = await import("./payment.service.js");
    await refundPayment("pay-1", { amount: "20.00", reason: "partial" }, actor);

    expect(tx.payment.update).not.toHaveBeenCalled();
  });

  it("records a cash refund without touching the gateway", async () => {
    vi.mocked(prisma.payment.findUnique).mockResolvedValue(
      settledPayment({ provider: null, providerRef: null }),
    );
    const tx = makeTx({ aggregate: ["50.00", "20.00"] });
    tx.payment.findUnique.mockResolvedValue(
      pendingPayment({ status: "SUCCEEDED", provider: null, providerRef: null }),
    );
    useTx(tx);

    const { refundPayment } = await import("./payment.service.js");
    const { stripeProvider } = await import("./payments/stripe.provider.js");

    await refundPayment("pay-1", { amount: "20.00", reason: "cash" }, actor);

    expect(stripeProvider.refund).not.toHaveBeenCalled();
    expect(tx.payment.update).toHaveBeenCalled();
  });
});
