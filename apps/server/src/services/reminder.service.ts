import { prisma } from "../config/db.js";
import { logger } from "../utils/logger.js";
import { dispatchNotification, clearReminderJobIds } from "./notification.service.js";
import * as settingsService from "./settings.service.js";

/** Date and time as the hospital's clock reads them — what a patient expects to see. */
function formatInZone(when: Date, timeZone: string): { date: string; time: string } {
  try {
    return {
      date: new Intl.DateTimeFormat("en-CA", { timeZone, dateStyle: "short" }).format(when),
      time: new Intl.DateTimeFormat("en-GB", {
        timeZone,
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(when),
    };
  } catch {
    // An invalid zone in settings must not stop a reminder.
    return { date: when.toISOString().slice(0, 10), time: when.toISOString().slice(11, 16) };
  }
}

export type ReminderType = "24h" | "1h";

const TITLES: Record<ReminderType, string> = {
  "24h": "Upcoming Appointment",
  "1h": "Appointment in 1 Hour",
};

function reminderLink(appointmentId: string): string {
  return `/patient/appointments/${appointmentId}`;
}

/**
 * Sends one pre-visit reminder. Shared by the BullMQ reminder worker (delayed jobs,
 * Redis on) and the in-process sweep (Redis off), so the two can never drift.
 *
 * Idempotent: a reminder of the same type already sent for this appointment is not
 * sent again. The sweep relies on that — a restart re-scans the same window.
 */
export async function sendAppointmentReminder(
  appointmentId: string,
  type: ReminderType,
): Promise<"sent" | "skipped"> {
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    include: {
      patient: { select: { userId: true } },
      doctor: { select: { fullName: true } },
      slot: { select: { startTime: true } },
    },
  });

  if (!appointment || appointment.deletedAt) return "skipped";
  if (appointment.status !== "CONFIRMED" && appointment.status !== "CHECKED_IN") return "skipped";

  const alreadySent = await prisma.notification.findFirst({
    where: {
      userId: appointment.patient.userId,
      type: "APPOINTMENT_REMINDER",
      title: TITLES[type],
      linkUrl: reminderLink(appointmentId),
    },
    select: { id: true },
  });
  if (alreadySent) return "skipped";

  await clearReminderJobIds(appointmentId);

  const settings = (await settingsService.get()) as { timezone?: string };
  const { date, time } = formatInZone(appointment.slot.startTime, settings.timezone || "UTC");
  await dispatchNotification({
    userId: appointment.patient.userId,
    type: "APPOINTMENT_REMINDER",
    title: TITLES[type],
    message:
      type === "24h"
        ? `You have an appointment with Dr. ${appointment.doctor.fullName} on ${date} at ${time}.`
        : `Your appointment with Dr. ${appointment.doctor.fullName} starts in 1 hour.`,
    linkUrl: reminderLink(appointmentId),
    // These fill the SMS template. They used to carry the doctor's *email*, the
    // date the appointment was booked and the slot's UUID as the "time".
    data: {
      doctorName: appointment.doctor.fullName,
      date,
      time,
      appointmentNo: appointment.appointmentNo,
    },
  });

  logger.info({ appointmentId, type }, "[reminders] Reminder dispatched");
  return "sent";
}

/**
 * Finds appointments whose reminder is due and sends it. The Redis-off substitute
 * for the delayed jobs `bookAppointment` would otherwise enqueue: run every few
 * minutes, it reminds anything starting inside each window that has not been
 * reminded yet.
 */
export async function sweepDueReminders(now = new Date()): Promise<{ sent: number }> {
  const windows: Array<{ type: ReminderType; from: number; to: number }> = [
    // 24h reminder: due once the visit is less than 24h away, until it is 1h away.
    { type: "24h", from: 60 * 60 * 1000, to: 24 * 60 * 60 * 1000 },
    { type: "1h", from: 0, to: 60 * 60 * 1000 },
  ];

  let sent = 0;
  for (const w of windows) {
    const due = await prisma.appointment.findMany({
      where: {
        deletedAt: null,
        status: { in: ["CONFIRMED", "CHECKED_IN"] },
        slot: {
          startTime: {
            gt: new Date(now.getTime() + w.from),
            lte: new Date(now.getTime() + w.to),
          },
        },
        // A walk-in is booked at the desk with the patient standing there.
        source: { not: "WALK_IN" },
      },
      select: { id: true },
      take: 200,
    });
    for (const appointment of due) {
      try {
        if ((await sendAppointmentReminder(appointment.id, w.type)) === "sent") sent++;
      } catch (err) {
        logger.error({ err, appointmentId: appointment.id }, "[reminders] Reminder failed");
      }
    }
  }
  return { sent };
}
