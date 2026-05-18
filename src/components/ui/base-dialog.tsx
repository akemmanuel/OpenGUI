import type { ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

interface BaseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
  headerClassName?: string;
  bodyClassName?: string;
  footerClassName?: string;
}

export function BaseDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  className = "sm:max-w-md",
  headerClassName,
  bodyClassName,
  footerClassName,
}: BaseDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={className}>
        <DialogHeader className={headerClassName}>
          <DialogTitle>{title}</DialogTitle>
          {description != null && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {children != null && <div className={cn("min-h-0", bodyClassName)}>{children}</div>}
        {footer != null && <DialogFooter className={footerClassName}>{footer}</DialogFooter>}
      </DialogContent>
    </Dialog>
  );
}
