import { prisma } from "../src/config/db.js";
import { stripeProvider } from "../src/services/payments/stripe.provider.js";
import { reconcilePayment } from "../src/services/payment.service.js";
import type { IntentStatus } from "../src/services/payments/PaymentProvider.js";

/**
 * Reconciles PENDING card payments against Stripe — the source of truth for
 * whether money actually moved.
 *
 * Why this exists: before the checkout reused open intents, every opening of the
 * card dialog created a fresh intent and a PENDING row, and with no webhook
 * reaching the API none of them was ever settled. Most are abandoned; any that a
 * patient actually completed are real money the bill never saw.
 *
 *   npx tsx scripts/reconcile-payments.ts            dry run — reads Stripe, writes nothing
 *   npx tsx scripts/reconcile-payments.ts --apply    settle / retire for real
 *
 * With `--apply`:
 *   - succeeded in Stripe       → settled onto its bill (same code path as the webhook)
 *   - canceled in Stripe        → FAILED
 *   - still open, older than the reuse window → FAILED (abandoned checkout; nobody
 *     holds its client secret any more, and a late success would still be settled
 *     by the webhook because settlement accepts FAILED rows)
 *   - processing                → left alone
 *
 * Idempotent: settlement is guarded on the row's status, so a re-run (or a webhook
 * racing it) never double-settles.
 */

const APPLY = process.argv.includes("--apply");
const CONCURRENCY = 6; // well under Stripe's test-mode read limit
const ABANDONED_AFTER_MS = 24 * 60 * 60 * 1000;

type Outcome =
  "settled" | "already_settled" | "canceled" | "abandoned" | "processing" | "open_recent" | "error";

async function inspect(row: {
  id: string;
  providerRef: string;
  createdAt: Date;
}): Promise<Outcome> {
  let intent: IntentStatus;
  try {
    intent = await stripeProvider.retrieveIntent(row.providerRef);
  } catch (err) {
    console.error(`  ${row.providerRef}: ${(err as Error).message}`);
    return "error";
  }

  const abandoned = Date.now() - row.createdAt.getTime() > ABANDONED_AFTER_MS;

  switch (intent.state) {
    case "succeeded": {
      if (!APPLY) return "settled";
      const result = await reconcilePayment(row.id);
      return result.changed ? "settled" : "already_settled";
    }
    case "canceled":
      if (APPLY) await reconcilePayment(row.id);
      return "canceled";
    case "processing":
      return "processing";
    case "open":
      if (!abandoned) return "open_recent";
      if (APPLY) {
        await prisma.payment.updateMany({
          where: { id: row.id, status: "PENDING" },
          data: { status: "FAILED" },
        });
      }
      return "abandoned";
  }
}

async function main() {
  const rows = await prisma.payment.findMany({
    where: { provider: "stripe", status: "PENDING", providerRef: { not: null } },
    select: { id: true, providerRef: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  console.log(`${rows.length} pending Stripe payment(s). Mode: ${APPLY ? "APPLY" : "dry run"}`);

  const tally: Record<Outcome, number> = {
    settled: 0,
    already_settled: 0,
    canceled: 0,
    abandoned: 0,
    processing: 0,
    open_recent: 0,
    error: 0,
  };

  let next = 0;
  let done = 0;
  async function worker() {
    while (next < rows.length) {
      const row = rows[next++];
      const outcome = await inspect({ ...row, providerRef: row.providerRef! });
      tally[outcome]++;
      if (++done % 250 === 0) console.log(`  …${done}/${rows.length}`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  console.log("\nOutcome per payment:");
  console.table(tally);
  if (!APPLY) console.log("Dry run — nothing was written. Re-run with --apply to reconcile.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
