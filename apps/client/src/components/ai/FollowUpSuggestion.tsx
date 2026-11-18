import { useState } from "react";
import { CalendarClock, Sparkles, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useRecommendFollowUp } from "../../hooks/mutations/useAiMutations";
import AIDisclaimer from "./AIDisclaimer";
import { Button } from "../ui/button";
import { getErrorMessage } from "../../utils/errors";

/**
 * AI follow-up suggestion inside the prescription editor (treating doctor only).
 *
 * The model proposes an interval with its reasoning; nothing is written until the
 * doctor presses "Apply", which only fills the form's "Follow-up after (days)"
 * field — the doctor still saves or issues the prescription themselves (AI never
 * writes to the record).
 */
export default function FollowUpSuggestion({
  appointmentId,
  onApply,
}: {
  appointmentId: string;
  onApply: (days: number) => void;
}) {
  const { t } = useTranslation(["ai", "common"]);
  const suggest = useRecommendFollowUp();
  const [open, setOpen] = useState(false);

  function request() {
    setOpen(true);
    suggest.mutate(appointmentId);
  }

  const data = suggest.data;

  return (
    <div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={request}
        disabled={suggest.isPending}
      >
        <span className="flex items-center gap-1">
          <Sparkles className={`h-3.5 w-3.5 ${suggest.isPending ? "animate-pulse" : ""}`} />
          {suggest.isPending ? t("ai:thinking") : t("ai:suggestFollowUp")}
        </span>
      </Button>

      {open && (
        <div className="mt-3 rounded-lg border border-teal-100 bg-teal-50/60 p-3 text-sm dark:border-teal-900 dark:bg-teal-950/40">
          <div className="flex items-start justify-between gap-2">
            <span className="flex items-center gap-1.5 text-xs font-semibold text-teal-700 dark:text-teal-300">
              <CalendarClock className="h-3.5 w-3.5" /> {t("ai:followUpTitle")}
            </span>
            <button
              type="button"
              className="text-gray-400 hover:text-gray-600"
              onClick={() => setOpen(false)}
              aria-label={t("common:close")}
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {suggest.isError && <p className="mt-2 text-red-600">{getErrorMessage(suggest.error)}</p>}

          {data && data.intervalDays !== null && (
            <div className="mt-2 space-y-2">
              <p className="font-semibold text-gray-900 dark:text-gray-100">
                {t("ai:followUpInDays", { count: data.intervalDays })}
              </p>
              {data.instructions && (
                <p className="whitespace-pre-wrap text-gray-800 dark:text-gray-200">
                  {data.instructions}
                </p>
              )}
              {data.rationale && (
                <p className="whitespace-pre-wrap text-xs text-gray-600 dark:text-gray-400">
                  <span className="font-semibold">{t("ai:rationale")}: </span>
                  {data.rationale}
                </p>
              )}
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  onApply(data.intervalDays!);
                  setOpen(false);
                }}
              >
                {t("ai:applyFollowUp", { count: data.intervalDays })}
              </Button>
            </div>
          )}

          {data && data.intervalDays === null && (
            <p className="mt-2 text-amber-800">{t("ai:followUpUnavailable")}</p>
          )}

          <AIDisclaimer className="mt-3" />
        </div>
      )}
    </div>
  );
}
