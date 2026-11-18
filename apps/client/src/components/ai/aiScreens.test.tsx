import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import type { ReactElement } from "react";
import PrescriptionExplainButton from "./PrescriptionExplainButton";
import FollowUpSuggestion from "./FollowUpSuggestion";
import RecordOcrPanel from "./RecordOcrPanel";
import { aiApi } from "../../api/ai";

// Keys render as themselves (plus the count) so assertions read the contract, not copy.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { count?: number }) =>
      opts?.count !== undefined ? `${key}:${opts.count}` : key,
  }),
}));

vi.mock("../../api/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/ai")>();
  return {
    ...actual,
    aiApi: {
      ...actual.aiApi,
      explainPrescription: vi.fn(),
      recommendFollowUp: vi.fn(),
      ocrRecord: vi.fn(),
    },
  };
});

function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => vi.clearAllMocks());

describe("PrescriptionExplainButton", () => {
  it("shows the prescribed regimen verbatim, the AI context, and the disclaimer", async () => {
    vi.mocked(aiApi.explainPrescription).mockResolvedValue({
      purpose: "Commonly used to reduce the risk of clots.",
      howToTake: "Aspirin: 75mg, od for 30 day(s) — after food",
      sideEffects: ["Upset stomach"],
      lifestyleNotes: [],
      warnings: ["Tell your doctor about any bleeding."],
      fallback: false,
    });

    renderWithClient(<PrescriptionExplainButton prescriptionId="rx1" />);
    await userEvent.click(screen.getByRole("button", { name: /ai:explainPrescription/ }));

    expect(
      await screen.findByText("Aspirin: 75mg, od for 30 day(s) — after food"),
    ).toBeInTheDocument();
    expect(screen.getByText("ai:asPrescribed")).toBeInTheDocument();
    expect(screen.getByText("Upset stomach")).toBeInTheDocument();
    expect(screen.getByText("Tell your doctor about any bleeding.")).toBeInTheDocument();
    // An empty list renders no heading at all.
    expect(screen.queryByText("ai:lifestyleNotes")).not.toBeInTheDocument();
    expect(screen.getByText("disclaimer")).toBeInTheDocument();
    expect(aiApi.explainPrescription).toHaveBeenCalledWith("rx1", expect.anything());
  });

  it("still shows the regimen when the AI part is unavailable", async () => {
    vi.mocked(aiApi.explainPrescription).mockResolvedValue({
      purpose: null,
      howToTake: "Aspirin: 75mg, od for 30 day(s)",
      sideEffects: [],
      lifestyleNotes: [],
      warnings: [],
      fallback: true,
    });

    renderWithClient(<PrescriptionExplainButton prescriptionId="rx1" />);
    await userEvent.click(screen.getByRole("button", { name: /ai:explainPrescription/ }));

    expect(await screen.findByText("Aspirin: 75mg, od for 30 day(s)")).toBeInTheDocument();
    expect(screen.getByText("ai:prescriptionExplainUnavailable")).toBeInTheDocument();
  });
});

describe("FollowUpSuggestion", () => {
  it("fills the form only when the doctor applies the suggestion", async () => {
    vi.mocked(aiApi.recommendFollowUp).mockResolvedValue({
      intervalDays: 14,
      instructions: "Review blood pressure.",
      rationale: "Medication started at this visit.",
      fallback: false,
    });
    const onApply = vi.fn();

    renderWithClient(<FollowUpSuggestion appointmentId="a1" onApply={onApply} />);
    await userEvent.click(screen.getByRole("button", { name: /ai:suggestFollowUp/ }));

    expect(await screen.findByText("ai:followUpInDays:14")).toBeInTheDocument();
    expect(screen.getByText("Review blood pressure.")).toBeInTheDocument();
    expect(screen.getByText("disclaimer")).toBeInTheDocument();
    expect(onApply).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "ai:applyFollowUp:14" }));
    expect(onApply).toHaveBeenCalledWith(14);
  });

  it("offers nothing to apply when no suggestion is available", async () => {
    vi.mocked(aiApi.recommendFollowUp).mockResolvedValue({
      intervalDays: null,
      instructions: null,
      rationale: null,
      fallback: true,
    });

    renderWithClient(<FollowUpSuggestion appointmentId="a1" onApply={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: /ai:suggestFollowUp/ }));

    expect(await screen.findByText("ai:followUpUnavailable")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /ai:applyFollowUp/ })).not.toBeInTheDocument();
  });
});

describe("RecordOcrPanel", () => {
  it("shows the summary above the verbatim transcription", async () => {
    vi.mocked(aiApi.ocrRecord).mockResolvedValue({
      extractedText: "Haemoglobin: 10.9 g/dL (ref 12.0-15.5) LOW",
      summary: "A blood test sheet; haemoglobin is flagged low.",
      fallback: false,
    });

    renderWithClient(<RecordOcrPanel recordId="r1" />);
    await userEvent.click(screen.getByRole("button", { name: /ai:readDocument/ }));

    expect(
      await screen.findByText("A blood test sheet; haemoglobin is flagged low."),
    ).toBeInTheDocument();
    expect(screen.getByText("Haemoglobin: 10.9 g/dL (ref 12.0-15.5) LOW")).toBeInTheDocument();
    expect(screen.getByText("disclaimer")).toBeInTheDocument();
  });

  it("keeps the transcription when only the summary is missing", async () => {
    vi.mocked(aiApi.ocrRecord).mockResolvedValue({
      extractedText: "Rx: Amoxicillin 500mg tds",
      summary: null,
      fallback: false,
    });

    renderWithClient(<RecordOcrPanel recordId="r1" />);
    await userEvent.click(screen.getByRole("button", { name: /ai:readDocument/ }));

    expect(await screen.findByText("Rx: Amoxicillin 500mg tds")).toBeInTheDocument();
    expect(screen.getByText("ai:ocrSummaryUnavailable")).toBeInTheDocument();
  });

  it("explains when the page could not be read", async () => {
    vi.mocked(aiApi.ocrRecord).mockResolvedValue({
      extractedText: null,
      summary: null,
      fallback: true,
    });

    renderWithClient(<RecordOcrPanel recordId="r1" />);
    await userEvent.click(screen.getByRole("button", { name: /ai:readDocument/ }));

    await waitFor(() => expect(screen.getByText("ai:ocrUnavailable")).toBeInTheDocument());
  });
});
