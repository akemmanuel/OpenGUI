import { ArrowLeft } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { AccountSection } from "@/features/identity/AccountSection";
import { PersonalInstructions } from "@/features/instructions/InstructionsSettings";
import type { ProfileView } from "./AccountMenu";

function SubView({ children }: { children: ReactNode }) {
  return (
    <div className="space-y-5 px-3 py-4 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-right-2 motion-safe:duration-200">
      {children}
    </div>
  );
}

/**
 * One personal settings group shown in place of the chat list, opened from
 * the account menu. Host-wide configuration stays in Settings.
 */
export function ProfilePanel({ view, onClose }: { view: ProfileView; onClose: () => void }) {
  const { t } = useTranslation();
  const [instructionsDirty, setInstructionsDirty] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const back = useCallback(() => {
    if (instructionsDirty && !window.confirm(t("profile.discardInstructions"))) return;
    setInstructionsDirty(false);
    onClose();
  }, [instructionsDirty, onClose, t]);

  useEffect(() => {
    panelRef.current?.focus({ preventScroll: true });
  }, [view]);

  const title = {
    account: t("profile.account"),
    instructions: t("profile.personalInstructions"),
  }[view];

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      role="region"
      aria-label={title}
      className="flex min-h-0 flex-1 flex-col outline-none"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.stopPropagation();
          back();
        }
      }}
    >
      <div
        className="flex h-10 shrink-0 items-center gap-1 border-b border-sidebar-border px-1.5"
        style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
      >
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={back}
          aria-label={t("profile.close")}
          title={t("profile.close")}
          className="text-muted-foreground"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
          <ArrowLeft />
        </Button>
        <h2 className="truncate text-sm font-semibold">{title}</h2>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-width:thin]">
        {view === "account" && (
          <SubView>
            <AccountSection />
          </SubView>
        )}
        {view === "instructions" && (
          <SubView>
            <PersonalInstructions onDirty={setInstructionsDirty} />
          </SubView>
        )}
      </div>
    </div>
  );
}
