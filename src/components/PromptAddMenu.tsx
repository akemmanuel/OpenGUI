import { Paperclip, Plus, Wrench } from "lucide-react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function PromptAddMenu({
  disabled,
  canManageMcp,
  fileInputRef,
  onOpenMcp,
}: {
  disabled: boolean;
  canManageMcp: boolean;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  onOpenMcp: () => void;
}) {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          title={t("prompt.add")}
          disabled={disabled}
          onClick={(e) => e.stopPropagation()}
        >
          <Plus />
          <span className="sr-only">{t("prompt.add")}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start">
        <DropdownMenuItem
          onClick={(e: React.MouseEvent) => {
            e.stopPropagation();
            fileInputRef.current?.click();
          }}
        >
          <Paperclip className="size-4" />
          {t("prompt.addFile")}
        </DropdownMenuItem>
        {canManageMcp && (
          <DropdownMenuItem
            onClick={(e: React.MouseEvent) => {
              e.stopPropagation();
              onOpenMcp();
            }}
          >
            <Wrench className="size-4" />
            {t("prompt.mcps")}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
