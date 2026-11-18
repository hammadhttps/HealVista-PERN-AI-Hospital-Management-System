import { Router } from "express";
import { authenticate } from "../middlewares/auth.middleware.js";
import { requireRole } from "../middlewares/rbac.middleware.js";
import { validate } from "../middlewares/validate.middleware.js";
import { aiRateLimit } from "../ai/aiRateLimit.middleware.js";
import {
  symptomCheckSchema,
  assistantQuerySchema,
  appointmentAssistSchema,
  timelineSummaryParamsSchema,
  semanticSearchSchema,
  semanticSearchAllSchema,
  kbArticleSchema,
  kbArticleUpdateSchema,
  kbAskSchema,
  analyticsQuerySchema,
} from "@healvista/shared";
import * as ai from "../controllers/ai.controller.js";

/**
 * AI routes (Phase 5).
 *
 * Every route that reaches the model is rate limited per user: the provider's
 * requests-per-minute cap is shared, and one user hammering it would exhaust it for
 * everyone. Generation is the expensive tier; retrieval-only search is cheaper and
 * gets a looser limit. Cache reads and KB administration are not limited.
 *
 * Ownership is enforced in the services, not by role: every `:id` route resolves
 * the caller's relationship to that id before any model call.
 */
const router = Router();

/** Generation: each call is one or two model round trips. */
const generate = aiRateLimit(30, 10 * 60 * 1000);
/** Retrieval-only search: one embedding call, no generation. */
const search = aiRateLimit(60, 10 * 60 * 1000);

router.post(
  "/symptom-check",
  authenticate,
  generate,
  validate(symptomCheckSchema),
  ai.checkSymptom,
);

router.post("/lab/:orderId/explain", authenticate, generate, ai.explainLab);

router.post("/prescriptions/:id/explain", authenticate, generate, ai.explainPrescription);

router.post(
  "/appointments/:appointmentId/follow-up",
  authenticate,
  requireRole("DOCTOR"),
  generate,
  ai.recommendFollowUp,
);

// Appointment assistant — patients (own appointment) and doctors (appointments they
// treat). The service verifies the relationship; no role guard is needed here.
router.post(
  "/appointments/:appointmentId/assist",
  authenticate,
  generate,
  validate(appointmentAssistSchema),
  ai.assistAppointment,
);

router.post("/records/:recordId/ocr", authenticate, generate, ai.ocrRecord);

// Reading a stored summary is cheap and needs no rate limit — it is a cache read.
router.get("/records/:recordId/summary", authenticate, ai.getRecordSummary);

router.post("/records/:recordId/summarize", authenticate, generate, ai.summarizeRecord);

// ─── RAG: assistant, timeline, semantic search ─────────────────────────────

router.post("/assistant", authenticate, generate, validate(assistantQuerySchema), ai.assistant);

router.get(
  "/timeline-summary/:patientId",
  authenticate,
  generate,
  validate(timelineSummaryParamsSchema, "params"),
  ai.timelineSummary,
);

router.post(
  "/search",
  authenticate,
  requireRole("DOCTOR"),
  search,
  validate(semanticSearchSchema),
  ai.semanticSearch,
);

router.post(
  "/search-all",
  authenticate,
  requireRole("DOCTOR"),
  search,
  validate(semanticSearchAllSchema),
  ai.semanticSearchAll,
);

// ─── Hospital knowledge base ────────────────────────────────────────────────
//
// Read + ask are open to every authenticated user — patients get the general
// Q&A ("what are visiting hours?") on the same surface staff use. Writing is
// ADMIN-only, and the service already hides drafts from non-admins.

router.get("/kb", authenticate, ai.kbList);

router.post("/kb/ask", authenticate, generate, validate(kbAskSchema), ai.kbAsk);

router.get("/kb/:id", authenticate, ai.kbGet);

router.post("/kb", authenticate, requireRole("ADMIN"), validate(kbArticleSchema), ai.kbCreate);

router.put(
  "/kb/:id",
  authenticate,
  requireRole("ADMIN"),
  validate(kbArticleUpdateSchema),
  ai.kbUpdate,
);

router.delete("/kb/:id", authenticate, requireRole("ADMIN"), ai.kbDelete);

// ─── Analytics assistant (ADMIN) ───────────────────────────────────────────

router.post(
  "/analytics",
  authenticate,
  requireRole("ADMIN"),
  generate,
  validate(analyticsQuerySchema),
  ai.analytics,
);

export default router;
