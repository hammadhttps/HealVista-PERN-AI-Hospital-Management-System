import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import MyPrescriptions from "./MyPrescriptions";
import { usePatientPrescriptions } from "../hooks/queries/useClinical";
import { prescriptionApi } from "../api/clinical";
import { downloadBlob } from "../lib/downloadBlob";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
  }),
}));

vi.mock("../hooks/queries/useAuth", () => ({
  useMe: () => ({ data: { patient: { id: "p1" } } }),
}));

vi.mock("../hooks/queries/useClinical", () => ({ usePatientPrescriptions: vi.fn() }));

vi.mock("../api/clinical", () => ({ prescriptionApi: { downloadPdf: vi.fn() } }));
vi.mock("../lib/downloadBlob", () => ({ downloadBlob: vi.fn() }));

const prescription = {
  id: "rx1",
  createdAt: "2026-08-01T10:00:00.000Z",
  notes: "Drink plenty of water.",
  appointment: { appointmentNo: "APT-1", doctor: { fullName: "Sarah Chen" } },
  items: [
    {
      id: "i1",
      medicineName: "Aspirin",
      dosage: "75mg",
      frequency: "od",
      durationDays: 30,
      instructions: "after food",
    },
  ],
};

function renderPage() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MyPrescriptions />
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.clearAllMocks());

describe("MyPrescriptions", () => {
  it("lists the patient's prescriptions with an explain button on each", () => {
    vi.mocked(usePatientPrescriptions).mockReturnValue({
      data: [prescription],
      isLoading: false,
      isError: false,
    } as never);

    renderPage();

    expect(usePatientPrescriptions).toHaveBeenCalledWith("p1");
    expect(screen.getByText("Aspirin")).toBeInTheDocument();
    expect(screen.getByText(/prescription:itemLine/)).toHaveTextContent("after food");
    expect(screen.getByText("Drink plenty of water.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /ai:explainPrescription/ })).toBeInTheDocument();
  });

  it("downloads the PDF through the authenticated API, not a bare link", async () => {
    vi.mocked(usePatientPrescriptions).mockReturnValue({
      data: [prescription],
      isLoading: false,
      isError: false,
    } as never);
    const blob = new Blob(["%PDF"], { type: "application/pdf" });
    vi.mocked(prescriptionApi.downloadPdf).mockResolvedValue(blob);

    renderPage();
    await userEvent.click(screen.getByRole("button", { name: /prescription:openPdf/ }));

    expect(prescriptionApi.downloadPdf).toHaveBeenCalledWith("rx1");
    expect(downloadBlob).toHaveBeenCalledWith(blob, "prescription-APT-1.pdf");
  });

  it("shows an empty state when there are no prescriptions", () => {
    vi.mocked(usePatientPrescriptions).mockReturnValue({
      data: [],
      isLoading: false,
      isError: false,
    } as never);

    renderPage();

    expect(screen.getByText("prescription:noPrescriptions")).toBeInTheDocument();
  });
});
