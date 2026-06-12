import type { ReactNode } from "react";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { DialogHeader } from "@/components/ui/DialogHeader";
import { cn } from "@/lib/utils";

interface DialogShellProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
  headerClassName?: string;
  titleClassName?: string;
  bodyClassName?: string;
  footerClassName?: string;
  showCloseButton?: boolean;
}

export function DialogShell({
  open,
  onOpenChange,
  title,
  description,
  icon,
  children,
  footer,
  className = "sm:max-w-md",
  headerClassName,
  titleClassName,
  bodyClassName,
  footerClassName,
  showCloseButton,
}: DialogShellProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={className} showCloseButton={showCloseButton}>
        <DialogHeader
          title={title}
          description={description}
          icon={icon}
          className={headerClassName}
          titleClassName={titleClassName}
        />
        {children != null && <div className={cn("min-h-0", bodyClassName)}>{children}</div>}
        {footer != null && <DialogFooter className={footerClassName}>{footer}</DialogFooter>}
      </DialogContent>
    </Dialog>
  );
}
