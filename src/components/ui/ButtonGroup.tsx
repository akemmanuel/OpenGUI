import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

interface ButtonGroupProps extends ComponentProps<"div"> {
  stretch?: boolean;
}

export function ButtonGroup({ className, stretch = false, ...props }: ButtonGroupProps) {
  return (
    <div
      data-slot="button-group"
      className={cn("flex gap-1", stretch && "[&>*]:flex-1", className)}
      {...props}
    />
  );
}
