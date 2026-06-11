import { Check, GitBranch, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export function PromptWorktreeSelector({
  shouldShow,
  selectedOption,
  isPendingTargetSelection,
  options,
  selectedDirectory,
  projectDir,
  worktreeParents,
  registerWorktree,
  setActiveTargetDirectory,
  onNewWorktree,
}: {
  shouldShow: boolean;
  selectedOption: any;
  isPendingTargetSelection: boolean;
  options: any[];
  selectedDirectory?: string | null;
  projectDir?: string | null;
  worktreeParents: Record<string, unknown>;
  registerWorktree: (path: string, parent: string, branch: string) => void;
  setActiveTargetDirectory: (path: string) => void;
  onNewWorktree: () => void;
}) {
  const { t } = useTranslation();
  if (!shouldShow || !selectedOption) return null;

  return (
    <div className="flex min-w-0 items-center gap-1">
      {isPendingTargetSelection ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="!h-7 w-auto max-w-[220px] gap-1.5 border-none bg-transparent px-2 py-0 text-xs text-muted-foreground shadow-none hover:text-foreground focus:ring-0"
            >
              <GitBranch className="size-3.5 shrink-0" />
              <span className="truncate">{selectedOption.label}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-80 w-56">
            {options.map((option) => (
              <DropdownMenuItem
                key={option.path}
                onClick={() => {
                  if (option.path !== projectDir && projectDir && !worktreeParents[option.path]) {
                    registerWorktree(option.path, projectDir, option.branch ?? "unknown");
                  }
                  setActiveTargetDirectory(option.path);
                }}
                className="text-xs"
              >
                <span className="flex min-w-0 flex-1 items-center gap-1.5">
                  <span className="truncate">{option.label}</span>
                </span>
                {option.path === selectedDirectory && <Check className="ml-auto size-3 shrink-0" />}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onNewWorktree} className="text-xs">
              <Plus className="size-3.5" />
              <span>{t("prompt.newWorktree")}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          title={selectedOption.isRoot ? t("prompt.currentRootWorktree") : undefined}
          className="!h-7 w-auto max-w-[220px] cursor-default gap-1.5 border-none bg-transparent px-2 py-0 text-xs text-muted-foreground shadow-none hover:bg-transparent hover:text-muted-foreground focus:ring-0"
          onClick={(event) => event.stopPropagation()}
        >
          <GitBranch className="size-3.5 shrink-0" />
          <span className="truncate">{selectedOption.label}</span>
        </Button>
      )}
    </div>
  );
}
