import type { QuestionAnswer, QuestionInfo } from "@opencode-ai/sdk/v2/client";
import { Check, MessageCircleQuestion, X } from "lucide-react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function QuestionPanel({
  questions,
  onSubmit,
  onDismiss,
}: {
  questions: QuestionInfo[];
  onSubmit: (answers: QuestionAnswer[]) => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  const [selections, setSelections] = useState<string[][]>(() => questions.map(() => []));
  const [customTexts, setCustomTexts] = useState<string[]>(() => questions.map(() => ""));

  const toggleOption = useCallback((qIdx: number, label: string, multiple: boolean) => {
    setSelections((prev) => {
      const next = [...prev];
      const current = next[qIdx] ?? [];
      next[qIdx] = multiple
        ? current.includes(label)
          ? current.filter((l) => l !== label)
          : [...current, label]
        : current.includes(label)
          ? []
          : [label];
      return next;
    });
  }, []);

  const handleCustomTextChange = useCallback((qIdx: number, text: string) => {
    setCustomTexts((prev) => {
      const next = [...prev];
      next[qIdx] = text;
      return next;
    });
  }, []);

  const handleSubmit = useCallback(() => {
    const answers: QuestionAnswer[] = questions.map((_q, i) => {
      const selected = selections[i] ?? [];
      const custom = (customTexts[i] ?? "").trim();
      return custom ? [...selected, custom] : selected;
    });
    onSubmit(answers);
  }, [questions, selections, customTexts, onSubmit]);

  const hasAllAnswers = questions.every(
    (_q, qIdx) =>
      (selections[qIdx]?.length ?? 0) > 0 || (customTexts[qIdx] ?? "").trim().length > 0,
  );

  return (
    <div className="border rounded-lg p-4 bg-primary/5 border-primary/20 space-y-4">
      <div className="flex items-start gap-2">
        <MessageCircleQuestion className="size-5 text-primary shrink-0 mt-0.5" />
        <span className="text-sm font-medium">{t("questionPanel.title")}</span>
      </div>

      {questions.map((q, qIdx) => {
        const allowCustom = q.custom !== false;
        return (
          <div key={`q-${q.header}-${qIdx}`} className="space-y-2">
            <div className="space-y-0.5">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                {q.header}
              </p>
              <p className="text-sm">{q.question}</p>
            </div>

            <div className="flex flex-wrap gap-1.5">
              {q.options.map((opt) => {
                const isSelected = (selections[qIdx] ?? []).includes(opt.label);
                return (
                  <button
                    key={opt.label}
                    type="button"
                    title={opt.description}
                    onClick={() => toggleOption(qIdx, opt.label, q.multiple ?? false)}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition-colors",
                      isSelected
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-muted/40 border-border hover:bg-muted text-foreground",
                    )}
                  >
                    {isSelected && <Check className="size-3" />}
                    {opt.label}
                  </button>
                );
              })}
            </div>

            {allowCustom && (
              <input
                type="text"
                placeholder={t("questionPanel.customAnswerPlaceholder")}
                value={customTexts[qIdx] ?? ""}
                onChange={(e) => handleCustomTextChange(qIdx, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && hasAllAnswers) {
                    e.preventDefault();
                    handleSubmit();
                  }
                }}
                className="w-full rounded-md border border-border bg-background px-3 py-1.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              />
            )}
          </div>
        );
      })}

      <div className="flex gap-2 pt-1">
        <Button size="sm" variant="default" disabled={!hasAllAnswers} onClick={handleSubmit}>
          {t("questionPanel.submit")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          <X className="size-3.5 mr-1" />
          {t("questionPanel.dismiss")}
        </Button>
      </div>
    </div>
  );
}
