import { isRedisEnabled } from "../config/redis.js";
import { logger } from "../utils/logger.js";
import { generateSlotsForAllDoctors } from "../services/slot.service.js";
import { scanExpiring, scanLowStock } from "../services/pharmacy.service.js";
import { sweepDueReminders } from "../services/reminder.service.js";

/**
 * The periodic jobs, run in-process when Redis is off.
 *
 * With `REDIS_ENABLED=false` no BullMQ scheduler or worker exists, and three jobs
 * simply stopped: nightly slot generation (doctors' calendars ran dry), the hourly
 * pharmacy stock sweep, and appointment reminders. This runs the same service
 * functions on timers instead. Each is idempotent, so an overlap with a restart is
 * harmless.
 *
 * Only for a single API instance — which is the only deployment where Redis can be
 * off (see config/redis.ts).
 */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/** Runs a job, logging instead of throwing, and never two copies at once. */
function guarded(name: string, job: () => Promise<unknown>): () => void {
  let running = false;
  return () => {
    if (running) return;
    running = true;
    const start = Date.now();
    job()
      .then((result) =>
        logger.info({ job: name, ms: Date.now() - start, result }, "[scheduler] Done"),
      )
      .catch((err) => logger.error({ job: name, err }, "[scheduler] Failed"))
      .finally(() => {
        running = false;
      });
  };
}

/** Milliseconds until the next local occurrence of hh:mm. */
function msUntil(hour: number, minute: number): number {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

export function startInProcessSchedules(): void {
  if (isRedisEnabled) return;

  const slots = guarded("slot-generation", async () => {
    const results = await generateSlotsForAllDoctors();
    return { doctors: results.length, slots: results.reduce((n, r) => n + r.count, 0) };
  });
  const pharmacy = guarded("pharmacy-sweep", async () => {
    const [lowStock, expiring] = await Promise.all([scanLowStock(), scanExpiring()]);
    return { lowStock, expiring };
  });
  const reminders = guarded("reminder-sweep", () => sweepDueReminders());

  // Slot generation: once shortly after boot — a host that sleeps when idle misses
  // 02:00 entirely — then nightly at 02:00.
  setTimeout(slots, 30 * 1000).unref();
  setTimeout(
    () => {
      slots();
      setInterval(slots, 24 * HOUR).unref();
    },
    msUntil(2, 0),
  ).unref();

  // Pharmacy: hourly on the hour.
  setTimeout(
    () => {
      pharmacy();
      setInterval(pharmacy, HOUR).unref();
    },
    msUntil(new Date().getHours() + 1, 0),
  ).unref();

  // Reminders: every five minutes, starting a minute after boot.
  setTimeout(reminders, MINUTE).unref();
  setInterval(reminders, 5 * MINUTE).unref();

  logger.warn(
    "[scheduler] Redis is off — slot generation, pharmacy sweep and reminders run in-process",
  );
}
