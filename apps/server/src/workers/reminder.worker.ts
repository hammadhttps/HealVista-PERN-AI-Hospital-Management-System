import { Worker } from "bullmq";
import { bullConnection } from "../config/redis.js";
import { prisma } from "../config/db.js";
import { dispatchNotification } from "../services/notification.service.js";
import { sendAppointmentReminder } from "../services/reminder.service.js";
import { logger } from "../utils/logger.js";

export function startReminderWorker(): Worker | null {
  if (!bullConnection) {
    logger.warn("[reminder-worker] Redis not available, worker disabled");
    return null;
  }

  const worker = new Worker(
    "reminders",
    async (job) => {
      const { appointmentId, type } = job.data as {
        appointmentId: string;
        type: "24h" | "1h" | "follow-up";
      };

      logger.info({ jobId: job.id, appointmentId, type }, "[reminder-worker] Processing reminder");

      const appointment = await prisma.appointment.findUnique({
        where: { id: appointmentId },
        include: {
          patient: { include: { user: true } },
          doctor: { select: { fullName: true } },
        },
      });

      if (!appointment || appointment.deletedAt) {
        logger.warn({ appointmentId }, "[reminder-worker] Appointment not found or deleted");
        return;
      }

      // A follow-up fires *after* the visit, so it expects COMPLETED — the opposite
      // of the pre-visit reminders, which are pointless once the visit is over.
      if (type === "follow-up") {
        if (appointment.status !== "COMPLETED") {
          logger.info(
            { appointmentId, status: appointment.status },
            "[reminder-worker] Skipping follow-up - visit did not complete",
          );
          return;
        }

        await dispatchNotification({
          userId: appointment.patient.user.id,
          type: "FOLLOW_UP_REMINDER",
          title: "Time to book your follow-up",
          message: `Dr. ${appointment.doctor.fullName} asked you to book a follow-up visit. Tap to choose a time.`,
          linkUrl: `/doctors/${appointment.doctorId}`,
          data: {
            doctorName: appointment.doctor.fullName,
            appointmentNo: appointment.appointmentNo,
          },
        });

        logger.info({ appointmentId }, "[reminder-worker] Follow-up reminder dispatched");
        return;
      }

      // Pre-visit reminders share one implementation with the Redis-off sweep.
      const outcome = await sendAppointmentReminder(appointmentId, type);
      logger.info({ appointmentId, type, outcome }, "[reminder-worker] Pre-visit reminder");
    },
    { connection: bullConnection },
  );

  worker.on("completed", (job) => {
    logger.info({ jobId: job.id }, "[reminder-worker] Completed");
  });

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err }, "[reminder-worker] Failed");
  });

  return worker;
}
