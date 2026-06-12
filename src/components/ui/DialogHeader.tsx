import type { ReactNode } from "react";
import {
  DialogDescription,
  DialogHeader as BaseDialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

interface DialogHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  className?: string;
  titleClassName?: string;
}

export function DialogHeader({
  title,
  description,
  icon,
  className,
  titleClassName,
}: DialogHeaderProps) {
  return (
    <BaseDialogHeader className={className}>
      <DialogTitle className={cn(icon != null && "flex items-center gap-2", titleClassName)}>
        {icon}
        {title}
      </DialogTitle>
      {description != null && <DialogDescription>{description}</DialogDescription>}
    </BaseDialogHeader>
  );
}
