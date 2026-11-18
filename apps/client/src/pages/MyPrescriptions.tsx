import { useState } from "react";
import { FileText, Pill } from "lucide-react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { useMe } from "../hooks/queries/useAuth";
import { usePatientPrescriptions } from "../hooks/queries/useClinical";
import { useActingPatientStore } from "../store/actingPatientStore";
import { prescriptionApi } from "../api/clinical";
import { downloadBlob } from "../lib/downloadBlob";
import PrescriptionExplainButton from "../components/ai/PrescriptionExplainButton";
import { Card, CardContent } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { EmptyState } from "../components/primitives/EmptyState";
import { CardSkeleton } from "../components/primitives/Skeleton";
import { getErrorMessage } from "../utils/errors";

interface PrescriptionItemRow {
  id: string;
  medicineName: string;
  dosage: string;
  frequency: string;
  durationDays: number;
  instructions: string | null;
}

export interface PrescriptionRow {
  id: string;
  createdAt: string;
  notes: string | null;
  items: PrescriptionItemRow[];
  appointment: { appointmentNo: string; doctor: { fullName: string } } | null;
}

/**
 * The patient's issued prescriptions — what to take and how, straight from what the
 * doctor wrote, with a PDF copy and an optional plain-language explanation. When a
 * guardian acts for a dependant, the dependant's prescriptions are shown.
 */
export default function MyPrescriptions() {
  const { t } = useTranslation(["prescription", "common"]);
  const { data: me } = useMe();
  const actingPatientId = useActingPatientStore((s) => s.actingPatientId);
  const patientId = actingPatientId ?? (me?.patient?.id as string | undefined) ?? "";
  const { data, isLoading, isError, error, refetch } = usePatientPrescriptions(patientId);
  const [downloading, setDownloading] = useState<string | null>(null);

  async function downloadPdf(prescription: PrescriptionRow) {
    setDownloading(prescription.id);
    try {
      const blob = await prescriptionApi.downloadPdf(prescription.id);
      downloadBlob(
        blob,
        `prescription-${prescription.appointment?.appointmentNo ?? prescription.id}.pdf`,
      );
    } catch (e) {
      toast.error(getErrorMessage(e, t("prescription:pdfFailed")));
    } finally {
      setDownloading(null);
    }
  }

  if (!patientId || isLoading) return <CardSkeleton />;

  const prescriptions = (data ?? []) as PrescriptionRow[];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">{t("prescription:myPrescriptionsTitle")}</h1>
        <p className="text-sm text-gray-500">{t("prescription:myPrescriptionsIntro")}</p>
      </div>

      {isError && (
        <Card>
          <CardContent className="flex items-center justify-between gap-3 p-4">
            <p className="text-sm text-red-600">
              {getErrorMessage(error, t("prescription:loadFailed"))}
            </p>
            <Button size="sm" variant="outline" onClick={() => refetch()}>
              {t("common:retry")}
            </Button>
          </CardContent>
        </Card>
      )}

      {!isError && prescriptions.length === 0 && (
        <EmptyState
          title={t("prescription:noPrescriptions")}
          description={t("prescription:noPrescriptionsHint")}
        />
      )}

      {prescriptions.map((p) => (
        <Card key={p.id}>
          <CardContent className="space-y-3 p-4">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="font-semibold">
                  {p.appointment
                    ? t("prescription:doctorName", { name: p.appointment.doctor.fullName })
                    : t("prescription:fallbackTitle")}
                </p>
                <p className="text-xs text-gray-500">
                  {new Date(p.createdAt).toLocaleDateString()}
                  {p.appointment ? ` · ${p.appointment.appointmentNo}` : ""}
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => downloadPdf(p)}
                disabled={downloading === p.id}
              >
                <FileText className="h-4 w-4" /> {t("prescription:openPdf")}
              </Button>
            </div>

            <ul className="divide-y divide-gray-100 rounded-md border border-gray-200 dark:divide-gray-800 dark:border-gray-800">
              {p.items.map((item) => (
                <li key={item.id} className="flex items-start gap-2 p-2 text-sm">
                  <Pill className="mt-0.5 h-4 w-4 shrink-0 text-teal-600" />
                  <div>
                    <p className="font-medium">{item.medicineName}</p>
                    <p className="text-gray-600 dark:text-gray-400">
                      {t("prescription:itemLine", {
                        dosage: item.dosage,
                        frequency: item.frequency,
                        days: item.durationDays,
                      })}
                      {item.instructions ? ` — ${item.instructions}` : ""}
                    </p>
                  </div>
                </li>
              ))}
            </ul>

            {p.notes && (
              <p className="whitespace-pre-wrap text-sm text-gray-700 dark:text-gray-300">
                {p.notes}
              </p>
            )}

            <PrescriptionExplainButton prescriptionId={p.id} />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
