import { Prisma, PrismaClient } from "@prisma/client";
import { dbQueryCounter } from "./queryCounter.js";

/**
 * The shared Prisma client.
 *
 * **Connection pool sizing.** Prisma defaults to `num_cpus * 2 + 1` client
 * connections, which on a small instance is around 9–17. That is not enough
 * here: several endpoints deliberately fan their queries out in parallel (see
 * `dashboard.service.ts`), so one in-flight request can hold six connections at
 * once, and a handful of concurrent users then exhaust the pool and fail with
 * P2024 "Timed out fetching a new connection".
 *
 * Raising it is safe because the app connects through the **Neon pooler**
 * (pgbouncer), whose entire job is to multiplex many short-lived client
 * connections onto a small number of real Postgres backends. The limit that
 * matters to Postgres is pgbouncer's, not ours.
 *
 * Both values are overridable from `DATABASE_URL` — anything already present in
 * the connection string wins, so an operator can tune this without a code change.
 */
const DEFAULT_CONNECTION_LIMIT = "25";
const DEFAULT_POOL_TIMEOUT = "20";
// Interactive transactions run on the direct client. Neon caps direct
// connections far below what a pgbouncer pool can multiplex, and an interactive
// transaction holds one for its whole lifetime, so a small pool is deliberate:
// these are brief and low-concurrency by nature.
const DEFAULT_DIRECT_CONNECTION_LIMIT = "5";

/**
 * Removes Prisma's `pgbouncer=true` compatibility mode for Neon's pooler.
 *
 * The flag exists for PgBouncer builds that cannot handle prepared statements.
 * Neon's pooler (PgBouncer 1.22+) handles them natively, and on it the flag made
 * every query 10–20× slower — measured from one machine against the same pooler:
 * `SELECT 1` took a median 5.5 s with the flag and 0.27 s without it, the same as
 * a direct connection. Every request in the app paid that on every query.
 *
 * Applied only to Neon pooler hosts; any other PgBouncer keeps whatever the URL says.
 */
function dropNeonPgbouncerFlag(url: URL): void {
  const isNeonPooler = url.hostname.endsWith(".neon.tech") && url.hostname.includes("-pooler.");
  if (isNeonPooler && url.searchParams.get("pgbouncer") === "true") {
    url.searchParams.delete("pgbouncer");
    console.warn(
      "[db] Ignoring pgbouncer=true for the Neon pooler — it is unnecessary there and made every query 10–20x slower. Remove it from DATABASE_URL.",
    );
  }
}

function withPoolSettings(
  url: string | undefined,
  limit: string = DEFAULT_CONNECTION_LIMIT,
): string | undefined {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.has("connection_limit")) {
      parsed.searchParams.set("connection_limit", limit);
    }
    if (!parsed.searchParams.has("pool_timeout")) {
      parsed.searchParams.set("pool_timeout", DEFAULT_POOL_TIMEOUT);
    }
    dropNeonPgbouncerFlag(parsed);
    return parsed.toString();
  } catch {
    // A malformed URL is Prisma's error to report, with its own clear message —
    // not something to swallow or half-rewrite here.
    return url;
  }
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
  prismaDirect: PrismaClient | undefined;
};

function withQueryCounting(client: PrismaClient): PrismaClient {
  if (!dbQueryCounter.enabled) return client;
  (client as unknown as { $on(event: "query", cb: () => void): void }).$on("query", () => {
    dbQueryCounter.value++;
  });
  return client;
}

const queryLog: Pick<Prisma.PrismaClientOptions, "log"> = dbQueryCounter.enabled
  ? { log: [{ emit: "event" as const, level: "query" as const }] }
  : {};

export const prisma =
  globalForPrisma.prisma ??
  withQueryCounting(
    new PrismaClient({
      ...queryLog,
      datasources: { db: { url: withPoolSettings(process.env.DATABASE_URL) } },
    }) as unknown as PrismaClient,
  );

/**
 * A second client pinned to the **direct** connection (DIRECT_URL), used only
 * for interactive `$transaction` callbacks.
 *
 * Interactive transactions are not reliable over Neon's PgBouncer-compatible
 * pooler: a transaction holds a pooler connection for its whole lifetime, and
 * under load the pooler stalls them past Prisma's 5s interactive-transaction
 * timeout ("Transaction not found" / "Transaction already closed"). Direct
 * connections are real sessions, so the transaction's statements stay on one
 * backend. All other queries keep going through `prisma` (pooled), where the
 * pooler's multiplexing is exactly what fan-out queries need.
 */
export const prismaDirect =
  globalForPrisma.prismaDirect ??
  withQueryCounting(
    new PrismaClient({
      ...queryLog,
      // Prisma's interactive-transaction defaults are aggressive for a serverless
      // Postgres: `maxWait` (acquire a connection, default 2s) and `timeout` (run
      // the whole transaction, default 5s) both intermittently expired under Neon's
      // variable latency — "Unable to start a transaction in the given time" and
      // "Transaction not found" (P2028) respectively. maxWait also has to absorb
      // re-establishing a direct connection that Neon closed during an idle gap.
      // 20s/30s absorb latency spikes without letting a genuinely dead connection
      // hang forever.
      transactionOptions: { maxWait: 20_000, timeout: 30_000 },
      datasources: {
        db: {
          url: withPoolSettings(
            process.env.DIRECT_URL ?? process.env.DATABASE_URL,
            DEFAULT_DIRECT_CONNECTION_LIMIT,
          ),
        },
      },
    }) as unknown as PrismaClient,
  );

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
  globalForPrisma.prismaDirect = prismaDirect;
}
