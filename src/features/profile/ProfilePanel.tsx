import { ArrowLeft, ChevronRight, LogOut, ScrollText, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@/components/ui/sidebar";
import { AccountSection, initialsFor } from "@/features/identity/AccountSection";
import { useIdentityActor } from "@/features/identity/identity-actor-context";
import { logoutActiveWorkspaceIdentity } from "@/features/identity/workspace-identity";
import {
  PersonalInstructions,
  usePersonalInstructionsAvailable,
} from "@/features/instructions/InstructionsSettings";
type View = "home" | "account" | "instructions";

function MenuRow({
  icon: Icon,
  label,
  value,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  value?: string;
  onClick: () => void;
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton type="button" className="h-10 gap-3" onClick={onClick}>
        <Icon className="text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {value && (
          <span className="max-w-[45%] truncate text-xs text-muted-foreground">{value}</span>
        )}
        <ChevronRight className="text-muted-foreground" aria-hidden="true" />
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function Home({
  onOpen,
  showInstructions,
}: {
  onOpen: (view: View) => void;
  showInstructions: boolean;
}) {
  const { t } = useTranslation();
  const actor = useIdentityActor();

  const [signingOut, setSigningOut] = useState(false);
  const signedIn = actor?.type === "user";
  return (
    <div className="space-y-4 px-1.5 py-3">
      {signedIn && (
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              type="button"
              size="lg"
              className="h-auto gap-3 py-2"
              onClick={() => onOpen("account")}
            >
              <span
                aria-hidden="true"
                className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground"
              >
                {initialsFor(actor.displayName)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{actor.displayName}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {t("profile.manageAccount")}
                </span>
              </span>
              <ChevronRight className="text-muted-foreground" aria-hidden="true" />
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      )}
      {showInstructions && (
        <SidebarMenu>
          <MenuRow
            icon={ScrollText}
            label={t("profile.personalInstructions")}
            onClick={() => onOpen("instructions")}
          />
        </SidebarMenu>
      )}
      {signedIn && (
        <SidebarMenu className="border-t border-sidebar-border pt-3">
          <SidebarMenuItem>
            <SidebarMenuButton
              type="button"
              disabled={signingOut}
              className="h-10 gap-3 text-muted-foreground hover:text-destructive"
              onClick={async () => {
                setSigningOut(true);
                try {
                  await logoutActiveWorkspaceIdentity();
                } catch {
                  toast.error(t("account.logoutFailed"));
                } finally {
                  setSigningOut(false);
                }
              }}
            >
              <LogOut aria-hidden="true" />
              <span>{t("identity.signOut")}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      )}
    </div>
  );
}

function SubView({ children }: { children: ReactNode }) {
  return (
    <div className="space-y-5 px-3 py-4 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-right-2 motion-safe:duration-200">
      {children}
    </div>
  );
}

/**
 * Personal settings shown in place of the chat list: a short menu whose rows
 * open one focused group at a time. Host-wide configuration stays in Settings.
 */
export function ProfilePanel({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const actor = useIdentityActor();
  const showInstructions = usePersonalInstructionsAvailable();
  const [view, setView] = useState<View>("home");
  const [instructionsDirty, setInstructionsDirty] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const signedIn = actor?.type === "user";

  const leave = useCallback(
    (next: () => void) => {
      if (instructionsDirty && !window.confirm(t("profile.discardInstructions"))) return;
      setInstructionsDirty(false);
      next();
    },
    [instructionsDirty, t],
  );
  const back = useCallback(() => {
    if (view === "home") leave(onClose);
    else leave(() => setView("home"));
  }, [leave, onClose, view]);

  useEffect(() => {
    panelRef.current?.focus({ preventScroll: true });
  }, [view]);

  const title = {
    home: signedIn ? t("profile.title") : t("profile.preferencesTitle"),
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
          aria-label={view === "home" ? t("profile.close") : t("common.back")}
          title={view === "home" ? t("profile.close") : t("common.back")}
          className="text-muted-foreground"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
          <ArrowLeft />
        </Button>
        <h2 className="truncate text-sm font-semibold">{title}</h2>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-width:thin]">
        {view === "home" && <Home onOpen={setView} showInstructions={showInstructions} />}
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
