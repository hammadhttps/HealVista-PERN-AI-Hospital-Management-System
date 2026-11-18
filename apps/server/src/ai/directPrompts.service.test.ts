import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma } from "../config/db.js";
import { isAiConfigured } from "./index.js";
import { AiGenerationError } from "./guardrails.js";
import { logInteraction } from "./aiInteraction.service.js";
import { assertTreatingDoctor } from "../services/note.service.js";
import { signDeliveryUrl } from "../services/record.service.js";
import {
  explainLabReport,
  explainPrescription,
  recommendFollowUp,
  ocrRecord,
  summarizeRecord,
} from "./directPrompts.service.js";

const { mockGenerate, mockTranscribe } = vi.hoisted(() => ({
  mockGenerate: vi.fn(),
  mockTranscribe: vi.fn(),
}));

vi.mock("../config/env.js", () => ({ env: { JINA_CHAT_MODEL: "jina-vlm" } }));

vi.mock("../config/db.js", () => ({
  prisma: {
    labOrder: { findUnique: vi.fn(), findMany: vi.fn() },
    prescription: { findUnique: vi.fn() },
    appointment: { findUnique: vi.fn() },
    medicalRecord: { findUnique: vi.fn(), update: vi.fn() },
    patient: { findUnique: vi.fn() },
  },
}));

vi.mock("../config/bull.js", () => ({ addSummaryJob: vi.fn() }));
vi.mock("../utils/audit.js", () => ({ writeAuditLog: vi.fn() }));
vi.mock("../services/access.service.js", () => ({
  assertClinicalAccess: vi.fn().mockResolvedValue({ allowed: true, reason: "treating_doctor" }),
}));
vi.mock("../services/note.service.js", () => ({
  assertTreatingDoctor: vi.fn().mockResolvedValue({
    appointment: { id: "a1", patientId: "p1", doctorId: "d1", status: "COMPLETED" },
    doctor: { id: "d1", fullName: "Dr. House" },
  }),
}));
vi.mock("../services/record.service.js", () => ({
  signDeliveryUrl: vi.fn().mockReturnValue("https://res.cloudinary.com/x/signed"),
}));

vi.mock("./index.js", () => ({
  getProvider: () => ({
    embed: vi.fn(),
    generate: mockGenerate,
    transcribe: mockTranscribe,
    lastUsage: vi.fn(() => ({})),
  }),
  isAiConfigured: vi.fn(),
}));

vi.mock("./aiInteraction.service.js", () => ({ logInteraction: vi.fn() }));

const actor = { userId: "u1", role: "DOCTOR" };

const order = {
  id: "o1",
  patientId: "p1",
  status: "VERIFIED",
  patient: { fullName: "Pat Doe" },
  items: [
    {
      labTest: { name: "Hemoglobin", code: "HB" },
      resultValue: "12.5",
      unit: "g/dL",
      referenceRange: "12-16",
      flag: "NORMAL",
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isAiConfigured).mockReturnValue(true);
  vi.mocked(prisma.labOrder.findUnique).mockResolvedValue(order as never);
  vi.mocked(prisma.patient.findUnique).mockResolvedValue({ fullName: "Pat Doe" } as never);
  vi.mocked(assertTreatingDoctor).mockResolvedValue({
    appointment: { id: "a1", patientId: "p1", doctorId: "d1", status: "COMPLETED" },
    doctor: { id: "d1", fullName: "Dr. House" },
  });
});

describe("explainLabReport", () => {
  it("returns a fallback with the raw flagged values when AI is unconfigured", async () => {
    vi.mocked(isAiConfigured).mockReturnValue(false);

    const result = await explainLabReport("o1", actor);

    expect(result.fallback).toBe(true);
    expect(result.explanation).toBeNull();
    expect(result.highlights).toHaveLength(1);
    expect(result.highlights[0].test).toBe("Hemoglobin");
    expect(logInteraction).toHaveBeenCalledWith(
      expect.objectContaining({ feature: "lab-explain", wasFallback: true }),
    );
  });

  it("returns the validated explanation on success", async () => {
    mockGenerate.mockResolvedValue({
      explanation: "Your hemoglobin is in the normal range.",
      notes: [{ test: "Hemoglobin", note: "Carries oxygen in the blood." }],
    });

    const result = await explainLabReport("o1", actor);

    expect(result.fallback).toBe(false);
    expect(result.explanation).toContain("hemoglobin");
    expect(result.highlights[0]).toEqual({
      test: "Hemoglobin",
      value: "12.5 g/dL",
      flag: "NORMAL",
      note: "Carries oxygen in the blood.",
    });
    expect(logInteraction).toHaveBeenCalledWith(
      expect.objectContaining({ feature: "lab-explain", wasFallback: false }),
    );
  });

  it("falls back when generation fails (malformed or declined output)", async () => {
    mockGenerate.mockRejectedValue(new AiGenerationError("provider declined"));

    const result = await explainLabReport("o1", actor);

    expect(result.fallback).toBe(true);
    expect(result.explanation).toBeNull();
  });

  it("takes values and flags from the record, never from the model", async () => {
    // The model only writes prose; a value it restates differently must not reach
    // the patient as the result.
    mockGenerate.mockResolvedValue({
      explanation: "Explained.",
      notes: [{ test: "HB", note: "Oxygen carrier." }],
    });

    const result = await explainLabReport("o1", actor);

    expect(result.highlights[0].value).toBe("12.5 g/dL");
    expect(result.highlights[0].flag).toBe("NORMAL");
    expect(result.highlights[0].note).toBe("Oxygen carrier.");
  });

  it("refuses a patient an order that has not been verified", async () => {
    // Regression: a patient received an unverified CRITICAL value this way.
    vi.mocked(prisma.labOrder.findUnique).mockResolvedValue({
      ...order,
      status: "COMPLETED",
    } as never);

    await expect(explainLabReport("o1", { userId: "pat", role: "PATIENT" })).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("still explains an unverified order to clinicians", async () => {
    vi.mocked(prisma.labOrder.findUnique).mockResolvedValue({
      ...order,
      status: "COMPLETED",
    } as never);
    mockGenerate.mockResolvedValue({ explanation: "Explained.", notes: [] });

    const result = await explainLabReport("o1", actor);
    expect(result.fallback).toBe(false);
  });

  it("refuses when there are no result values yet", async () => {
    vi.mocked(prisma.labOrder.findUnique).mockResolvedValue({
      ...order,
      items: [{ labTest: { name: "Hemoglobin", code: "HB" }, resultValue: null, flag: null }],
    } as never);

    await expect(explainLabReport("o1", actor)).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe("explainPrescription", () => {
  it("refuses to explain a draft prescription", async () => {
    vi.mocked(prisma.prescription.findUnique).mockResolvedValue({
      id: "rx1",
      isDraft: true,
      appointment: { patientId: "p1" },
    } as never);

    await expect(explainPrescription("rx1", actor)).rejects.toMatchObject({ statusCode: 400 });
  });

  it("returns a fallback without calling the provider when AI is unconfigured", async () => {
    vi.mocked(isAiConfigured).mockReturnValue(false);
    vi.mocked(prisma.prescription.findUnique).mockResolvedValue({
      id: "rx1",
      isDraft: false,
      deletedAt: null,
      appointment: { patientId: "p1" },
      items: [
        {
          medicineName: "Aspirin",
          dosage: "75mg",
          frequency: "od",
          durationDays: 30,
          instructions: null,
        },
      ],
      notes: null,
    } as never);

    const result = await explainPrescription("rx1", actor);

    expect(result.fallback).toBe(true);
    expect(mockGenerate).not.toHaveBeenCalled();
  });
});

describe("recommendFollowUp", () => {
  it("enforces the treating-doctor gate before anything else", async () => {
    const boom = new Error("Only the treating doctor may write this consultation note") as Error & {
      statusCode: number;
    };
    boom.statusCode = 403;
    vi.mocked(assertTreatingDoctor).mockRejectedValue(boom);
    vi.mocked(prisma.appointment.findUnique).mockResolvedValue(null);

    await expect(recommendFollowUp("a1", actor)).rejects.toMatchObject({ statusCode: 403 });
    expect(prisma.appointment.findUnique).not.toHaveBeenCalled();
  });

  it("returns a fallback when AI is unconfigured", async () => {
    vi.mocked(isAiConfigured).mockReturnValue(false);
    vi.mocked(prisma.appointment.findUnique).mockResolvedValue({
      id: "a1",
      patientId: "p1",
      reasonNote: "Follow-up on fever",
      note: { assessment: "Viral fever", plan: "Rest" },
      prescription: null,
    } as never);
    vi.mocked(prisma.labOrder.findMany).mockResolvedValue([] as never);

    const result = await recommendFollowUp("a1", actor);

    expect(result.fallback).toBe(true);
    expect(result.intervalDays).toBeNull();
    expect(assertTreatingDoctor).toHaveBeenCalledWith("a1", actor);
  });
});

describe("ocrRecord", () => {
  it("rejects non-image records", async () => {
    vi.mocked(prisma.medicalRecord.findUnique).mockResolvedValue({
      id: "r1",
      patientId: "p1",
      fileType: "pdf",
      title: "CBC",
      deletedAt: null,
    } as never);

    await expect(ocrRecord("r1", actor)).rejects.toMatchObject({ statusCode: 400 });
    expect(signDeliveryUrl).not.toHaveBeenCalled();
  });

  it("returns a fallback without fetching when AI is unconfigured", async () => {
    vi.mocked(isAiConfigured).mockReturnValue(false);
    vi.mocked(prisma.medicalRecord.findUnique).mockResolvedValue({
      id: "r1",
      patientId: "p1",
      fileType: "jpeg",
      title: "Prescription photo",
      deletedAt: null,
    } as never);

    const result = await ocrRecord("r1", actor);

    expect(result.fallback).toBe(true);
    expect(signDeliveryUrl).not.toHaveBeenCalled();
  });
});

describe("ocrRecord (two-step: OCR model, then summary)", () => {
  const imageRecord = {
    id: "r1",
    patientId: "p1",
    fileType: "png",
    fileUrl: "https://res.cloudinary.com/x/raw",
    title: "Lab sheet",
    deletedAt: null,
    patient: { fullName: "Pat Doe" },
  };

  beforeEach(() => {
    vi.mocked(prisma.medicalRecord.findUnique).mockResolvedValue(imageRecord as never);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }),
    );
  });

  it("returns the verbatim transcription and a checked summary", async () => {
    mockTranscribe.mockResolvedValue("Haemoglobin: 10.9 g/dL (ref 12.0-15.5) LOW");
    mockGenerate.mockResolvedValue({ summary: "A blood test sheet; haemoglobin is flagged low." });

    const result = await ocrRecord("r1", actor);

    expect(result).toEqual({
      extractedText: "Haemoglobin: 10.9 g/dL (ref 12.0-15.5) LOW",
      summary: "A blood test sheet; haemoglobin is flagged low.",
      fallback: false,
    });
    expect(mockTranscribe).toHaveBeenCalledWith({
      mimeType: "image/png",
      data: expect.any(String),
    });
  });

  it("still returns the transcription when only the summary fails", async () => {
    mockTranscribe.mockResolvedValue("Rx: Amoxicillin 500mg tds");
    mockGenerate.mockRejectedValue(new AiGenerationError("down"));

    const result = await ocrRecord("r1", actor);

    expect(result.extractedText).toBe("Rx: Amoxicillin 500mg tds");
    expect(result.summary).toBeNull();
    expect(result.fallback).toBe(false);
  });

  it("falls back when the page cannot be read", async () => {
    const { AppError } = await import("../utils/AppError.js");
    mockTranscribe.mockRejectedValue(new AppError("no readable text", 422));

    const result = await ocrRecord("r1", actor);

    expect(result).toEqual({ extractedText: null, summary: null, fallback: true });
    expect(mockGenerate).not.toHaveBeenCalled();
  });
});

describe("summarizeRecord (queued)", () => {
  it("tries again on a record whose earlier attempt left a fallback marker", async () => {
    // Regression: one failed generation made a record unsummarisable forever.
    vi.mocked(prisma.medicalRecord.findUnique).mockResolvedValue({
      id: "r1",
      patientId: "p1",
      title: "CBC report",
      extractedText: "Hemoglobin 12.5 g/dL.",
      aiSummary: { fallback: true, generatedAt: "2026-08-05T12:56:23.058Z" },
      deletedAt: null,
      uploadedById: "u1",
    } as never);
    mockGenerate.mockResolvedValue({
      keyValues: [],
      flags: [],
      plainLanguageSummary: "A blood count report.",
    });

    await summarizeRecord("r1");

    expect(mockGenerate).toHaveBeenCalled();
    const { data } = vi.mocked(prisma.medicalRecord.update).mock.calls[0][0] as {
      data: { aiSummary: Record<string, unknown> };
    };
    expect(data.aiSummary.plainLanguageSummary).toBe("A blood count report.");
  });

  it("does not regenerate a record that already has a real summary", async () => {
    vi.mocked(prisma.medicalRecord.findUnique).mockResolvedValue({
      id: "r1",
      patientId: "p1",
      extractedText: "x",
      aiSummary: { plainLanguageSummary: "done" },
      deletedAt: null,
    } as never);

    await summarizeRecord("r1");

    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("does nothing when the record has no extractable text", async () => {
    vi.mocked(prisma.medicalRecord.findUnique).mockResolvedValue({
      id: "r1",
      patientId: "p1",
      extractedText: null,
      aiSummary: null,
      deletedAt: null,
    } as never);

    await summarizeRecord("r1");

    expect(mockGenerate).not.toHaveBeenCalled();
    expect(prisma.medicalRecord.update).not.toHaveBeenCalled();
  });

  it("writes a validated summary into MedicalRecord.aiSummary", async () => {
    vi.mocked(prisma.medicalRecord.findUnique).mockResolvedValue({
      id: "r1",
      patientId: "p1",
      title: "CBC report",
      extractedText: "Hemoglobin 12.5 g/dL. WBC 8000.",
      aiSummary: null,
      deletedAt: null,
      uploadedById: "u1",
    } as never);
    mockGenerate.mockResolvedValue({
      keyValues: [{ name: "Hemoglobin", value: "12.5", referenceRange: "12-16" }],
      flags: [],
      plainLanguageSummary: "Most values are within normal range.",
    });

    await summarizeRecord("r1");

    const update = vi.mocked(prisma.medicalRecord.update);
    expect(update).toHaveBeenCalledTimes(1);
    const { data } = update.mock.calls[0][0] as { data: { aiSummary: Record<string, unknown> } };
    expect(data.aiSummary.plainLanguageSummary).toBe("Most values are within normal range.");
    expect(data.aiSummary.keyValues).toHaveLength(1);
    expect(logInteraction).toHaveBeenCalledWith(
      expect.objectContaining({ feature: "report-summary", wasFallback: false }),
    );
  });

  it("writes a fallback marker instead of retrying forever on failure", async () => {
    vi.mocked(prisma.medicalRecord.findUnique).mockResolvedValue({
      id: "r1",
      patientId: "p1",
      title: "CBC report",
      extractedText: "Hemoglobin 12.5 g/dL.",
      aiSummary: null,
      deletedAt: null,
      uploadedById: "u1",
    } as never);
    mockGenerate.mockRejectedValue(new AiGenerationError("down"));

    await summarizeRecord("r1");

    const update = vi.mocked(prisma.medicalRecord.update);
    expect(update).toHaveBeenCalledWith({
      where: { id: "r1" },
      data: { aiSummary: expect.objectContaining({ fallback: true }) },
    });
  });
});

describe("labFlagProblem", () => {
  const items = [{ flag: "CRITICAL", labTest: { name: "Complete Blood Count", code: "CBC" } }];

  it("rejects prose that calls a flagged result normal", async () => {
    const { labFlagProblem } = await import("./directPrompts.service.js");
    expect(
      labFlagProblem(
        {
          explanation: "Your CBC Complete Blood Count is 7.9, which is within the normal range.",
          notes: [],
        },
        items,
      ),
    ).toContain("CRITICAL");
  });

  it("accepts prose that reports the flag", async () => {
    const { labFlagProblem } = await import("./directPrompts.service.js");
    expect(
      labFlagProblem(
        {
          explanation:
            "Your CBC is flagged critical and is outside the normal range; your doctor will explain it.",
          notes: [],
        },
        items,
      ),
    ).toBeNull();
  });
});

describe("explainPrescription dosing", () => {
  it("shows the prescribed regimen verbatim, never the model's version of it", async () => {
    // Regression: the model turned "75mg od for 30 days" into "every 4 to 6 hours as needed".
    vi.mocked(prisma.prescription.findUnique).mockResolvedValue({
      id: "rx1",
      isDraft: false,
      deletedAt: null,
      appointment: { patientId: "p1", patient: { fullName: "Pat Doe" } },
      items: [
        {
          medicineName: "Aspirin",
          dosage: "75mg",
          frequency: "od",
          durationDays: 30,
          instructions: "after food",
        },
      ],
      notes: null,
    } as never);
    mockGenerate.mockResolvedValue({
      purpose: "Commonly used to reduce the risk of clots.",
      howToTake: "One tablet every 4 to 6 hours as needed.",
      sideEffects: ["Upset stomach"],
    });

    const result = await explainPrescription("rx1", actor);

    expect(result.fallback).toBe(false);
    expect(result.howToTake).toBe("Aspirin: 75mg, od for 30 day(s) — after food");
    expect(result.howToTake).not.toMatch(/4 to 6 hours/);
    expect(result.lifestyleNotes).toEqual([]);
  });
});

describe("prescription explain medication safety", () => {
  it("rejects any amount or maximum dose (seen live: 'do not exceed 8160 mg')", async () => {
    const { rxUnsafeReason } = await import("./directPrompts.service.js");
    expect(rxUnsafeReason("Do not exceed 8160 mg of aspirin in a 24-hour period.")).toContain(
      "amount",
    );
    expect(rxUnsafeReason("Never take more than 2 tablets.")).toContain("amount");
  });

  it("allows the prescription's own medicine name and dose", async () => {
    // Live false positive: "Aspirin 75mg is used to …" — the name carries the dose.
    const { rxUnsafeReason } = await import("./directPrompts.service.js");
    expect(
      rxUnsafeReason("Aspirin 75mg is commonly used to help prevent clots.", [
        "Aspirin 75mg",
        "75mg",
      ]),
    ).toBeNull();
    expect(
      rxUnsafeReason("Aspirin 75mg: do not exceed 3000mg per day.", ["Aspirin 75mg"]),
    ).toContain("amount");
  });

  it("rejects telling the patient not to take a prescribed medicine", async () => {
    const { rxUnsafeReason } = await import("./directPrompts.service.js");
    expect(rxUnsafeReason("Do not take if you have a history of stomach ulcers.")).toContain(
      "tell your doctor",
    );
    expect(rxUnsafeReason("Stop taking it if you feel dizzy.")).not.toBeNull();
    expect(rxUnsafeReason("Tell your doctor if you notice unusual bleeding.")).toBeNull();
    expect(rxUnsafeReason("Take with food; avoid alcohol.")).toBeNull();
  });

  it("drops unsafe list items instead of showing them", async () => {
    const { safeRxLines } = await import("./directPrompts.service.js");
    expect(
      safeRxLines(
        ["Take with food.", "Do not exceed 3000mg per day.", "Tell your doctor about bleeding."],
        [],
      ),
    ).toEqual(["Take with food.", "Tell your doctor about bleeding."]);
  });
});
