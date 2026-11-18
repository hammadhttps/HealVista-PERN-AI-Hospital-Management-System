import { useState } from "react";
import { ScanText, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useOcrRecord } from "../../hooks/mutations/useAiMutations";
import AIDisclaimer from "./AIDisclaimer";
import { Button } from "../ui/button";
import { getErrorMessage } from "../../utils/errors";

/** File types the server can read with OCR. */
export const OCR_FILE_TYPES = ["png", "jpg", "jpeg"];

/**
 * "Read this document" for a photographed record — a handwritten prescription, a
 * scanned lab sheet. Shows the plain-language summary first and the verbatim
 * transcription beneath it, so the reader can check the summary against what the
 * page actually says. Nothing is saved: the original image stays the record.
 */
export default function RecordOcrPanel({ recordId }: { recordId: string }) {
  const { t } = useTranslation(["ai", "common"]);
  const ocr = useOcrRecord();
  const [open, setOpen] = useState(false);

  function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (!ocr.data) ocr.mutate(recordId);
  }

  const data = ocr.data;

  return (
    <div>
      <Button size="sm" variant="outline" onClick={toggle} disabled={ocr.isPending}>
        <span className="flex items-center gap-1">
          <ScanText className={`h-3.5 w-3.5 ${ocr.isPending ? "animate-pulse" : ""}`} />
          {ocr.isPending ? t("ai:readingDocument") : t("ai:readDocument")}
        </span>
      </Button>

      {open && (
        <div className="mt-3 rounded-lg border border-teal-100 bg-teal-50/60 p-3 text-sm dark:border-teal-900 dark:bg-teal-950/40">
          <div className="flex items-start justify-between gap-2">
            <span className="flex items-center gap-1.5 text-xs font-semibold text-teal-700 dark:text-teal-300">
              <ScanText className="h-3.5 w-3.5" /> {t("ai:ocrTitle")}
            </span>
            <button
              className="text-gray-400 hover:text-gray-600"
              onClick={() => setOpen(false)}
              aria-label={t("common:close")}
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {ocr.isError && <p className="mt-2 text-red-600">{getErrorMessage(ocr.error)}</p>}

          {data && data.fallback && <p className="mt-2 text-amber-800">{t("ai:ocrUnavailable")}</p>}

          {data && !data.fallback && (
            <div className="mt-2 space-y-3">
              {data.summary ? (
                <p className="whitespace-pre-wrap text-gray-800 dark:text-gray-200">
                  {data.summary}
                </p>
              ) : (
                <p className="text-amber-800">{t("ai:ocrSummaryUnavailable")}</p>
              )}
              {data.extractedText && (
                <div>
                  <p className="text-xs font-semibold text-gray-700 dark:text-gray-300">
                    {t("ai:ocrTranscription")}
                  </p>
                  <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-gray-200 bg-white p-2 font-sans text-xs text-gray-800 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200">
                    {data.extractedText}
                  </pre>
                </div>
              )}
            </div>
          )}

          <AIDisclaimer className="mt-3" />
        </div>
      )}
    </div>
  );
}
