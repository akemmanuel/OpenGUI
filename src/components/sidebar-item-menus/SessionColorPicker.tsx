import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ReactNode } from "react";
import type { SessionColor } from "@/hooks/use-agent-state";
import { cn } from "@/lib/utils";
import { SESSION_COLORS } from "./session-colors";

export function SessionColorPicker({
  currentColor,
  onSetColor,
  renderItem,
}: {
  currentColor: SessionColor | undefined;
  onSetColor: (color: SessionColor) => void;
  renderItem: (options: { key: string; children: ReactNode; onSelect: () => void }) => ReactNode;
}) {
  const { t } = useTranslation();
  return SESSION_COLORS.map((color) =>
    renderItem({
      key: color.value ?? "none",
      onSelect: () => onSetColor(color.value),
      children: (
        <>
          <span className={cn("size-3 rounded-full shrink-0", color.swatchClassName)} />
          <span>{t(color.labelKey)}</span>
          {(currentColor ?? null) === color.value && <Check className="ml-auto size-3.5" />}
        </>
      ),
    }),
  );
}
