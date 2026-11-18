import { useState } from "react";
import { Sparkles, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useExplainPrescription } from "../../hooks/mutations/useAiMutations";
import AIDisclaimer from "./AIDisclaimer";
import { Button } from "../ui/button";
import { getErrorMessage } from "../../utils/errors";

function BulletList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="text-xs font-semibold text-gray-700 dark:text-gray-300">{title}</p>
      <ul className="mt-1 list-disc space-y-0.5 ps-5 text-gray-800 dark:text-gray-200">
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * "Explain this prescription" for the patient taking it. The dosing shown is the
 * prescription exactly as the doctor wrote it — the server never lets the model
 * restate it — and the AI adds context around it: what it is commonly for, common
 * side effects, lifestyle notes.
 */
export default function PrescriptionExplainButton({ prescriptionId }: { prescriptionId: string }) {
  const { t } = useTranslation(["ai", "common"]);
  const explain = useExplainPrescription();
  const [open, setOpen] = useState(false);

  function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    explain.mutate(prescriptionId);
  }

  const data = explain.data;

  return (
    <div>
      <Button size="sm" variant="outline" onClick={toggle} disabled={explain.isPending}>
        <span className="flex items-center gap-1">
          <Sparkles className={`h-3.5 w-3.5 ${explain.isPending ? "animate-pulse" : ""}`} />
          {explain.isPending ? t("ai:explaining") : t("ai:explainPrescription")}
        </span>
      </Button>

      {open && (
        <div className="mt-3 rounded-lg border border-teal-100 bg-teal-50/60 p-4 dark:border-teal-900 dark:bg-teal-950/40">
          <div className="flex items-start justify-between gap-2">
            <span className="flex items-center gap-1.5 text-xs font-semibold text-teal-700 dark:text-teal-300">
              <Sparkles className="h-3.5 w-3.5" /> {t("ai:explanationTitle")}
            </span>
            <button
              className="text-gray-400 hover:text-gray-600"
              onClick={() => setOpen(false)}
              aria-label={t("common:close")}
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {explain.isError && (
            <p className="mt-2 text-sm text-red-600">{getErrorMessage(explain.error)}</p>
          )}

          {data && (
            <div className="mt-2 space-y-3 text-sm">
              {data.howToTake && (
                <div className="rounded-md border border-gray-200 bg-white p-2 dark:border-gray-700 dark:bg-gray-900">
                  <p className="text-xs font-semibold text-gray-700 dark:text-gray-300">
                    {t("ai:asPrescribed")}
                  </p>
                  <p className="mt-1 whitespace-pre-wrap text-gray-800 dark:text-gray-200">
                    {data.howToTake}
                  </p>
                </div>
              )}
              {data.purpose && (
                <p className="whitespace-pre-wrap text-gray-800 dark:text-gray-200">
                  {data.purpose}
                </p>
              )}
              <BulletList title={t("ai:sideEffects")} items={data.sideEffects} />
              <BulletList title={t("ai:lifestyleNotes")} items={data.lifestyleNotes} />
              <BulletList title={t("ai:warnings")} items={data.warnings} />
              {data.fallback && (
                <p className="text-amber-800">{t("ai:prescriptionExplainUnavailable")}</p>
              )}
            </div>
          )}

          <AIDisclaimer className="mt-3" />
        </div>
      )}
    </div>
  );
}
