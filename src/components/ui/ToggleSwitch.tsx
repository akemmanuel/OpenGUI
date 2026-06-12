import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface ToggleSwitchProps {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
  className?: string;
}

export function ToggleSwitch({
  checked,
  onCheckedChange,
  label,
  description,
  disabled,
  className,
}: ToggleSwitchProps) {
  return (
    <label className={cn("flex cursor-pointer items-start gap-2 text-sm", className)}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onCheckedChange(event.target.checked)}
        className="mt-0.5 size-4 rounded border-input"
      />
      <span>
        <span className="block">{label}</span>
        {description != null && (
          <span className="mt-1 block text-[11px] text-muted-foreground">{description}</span>
        )}
      </span>
    </label>
  );
}
