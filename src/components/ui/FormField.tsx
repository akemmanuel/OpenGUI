import type { ReactNode } from "react";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

interface FormFieldProps {
  label?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
  description?: ReactNode;
  className?: string;
  labelClassName?: string;
  descriptionClassName?: string;
}

export function FormField({
  label,
  htmlFor,
  children,
  description,
  className,
  labelClassName,
  descriptionClassName,
}: FormFieldProps) {
  return (
    <div className={cn("grid gap-2", className)}>
      {label != null && (
        <Label htmlFor={htmlFor} className={labelClassName}>
          {label}
        </Label>
      )}
      {children}
      {description != null && (
        <p className={cn("text-[11px] text-muted-foreground", descriptionClassName)}>
          {description}
        </p>
      )}
    </div>
  );
}
