/**
 * PROTOTYPE ONLY — four session bulk-action directions, switchable via ?variant=.
 * Question: where should selection state and bulk actions live without crushing sidebar space?
 */
import {
  Check,
  ChevronDown,
  Circle,
  FolderInput,
  Hash,
  MessageSquare,
  MoreHorizontal,
  Palette,
  Pin,
  Plus,
  Search,
  Settings,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useState } from "react";
import { PrototypeVariantSwitcher } from "@/components/prototype/PrototypeVariantSwitcher";

const VARIANTS = [
  { key: "A", label: "Contextual header" },
  { key: "B", label: "Floating command dock" },
  { key: "C", label: "Selection tray" },
  { key: "D", label: "Workspace command bar" },
] as const;

const sessions = [
  {
    id: "launch",
    title: "Launch plan and milestones",
    section: "Chats",
    selected: true,
    active: false,
    dot: "bg-sky-400",
  },
  {
    id: "email",
    title: "Customer email sequence",
    section: "Chats",
    selected: true,
    active: true,
    dot: "bg-violet-400",
  },
  {
    id: "research",
    title: "Competitor research",
    section: "Chats",
    selected: true,
    active: false,
    dot: "bg-amber-400",
  },
  {
    id: "landing",
    title: "Landing page revisions",
    section: "Website",
    selected: false,
    active: false,
    dot: "bg-emerald-400",
  },
  {
    id: "wordpress",
    title: "WordPress migration",
    section: "Website",
    selected: false,
    active: false,
    dot: "bg-rose-400",
  },
  {
    id: "deck",
    title: "Quarterly presentation",
    section: "Client work",
    selected: false,
    active: false,
    dot: "bg-sky-400",
  },
];

function IconButton({
  label,
  children,
  danger = false,
  quiet = false,
}: {
  label: string;
  children: React.ReactNode;
  danger?: boolean;
  quiet?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      className={`flex size-7 shrink-0 items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${danger ? "text-red-400 hover:bg-red-500/12" : quiet ? "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground" : "text-foreground hover:bg-sidebar-accent"}`}
    >
      {children}
    </button>
  );
}

function ActionSet({ labels = false }: { labels?: boolean }) {
  const actions = [
    [Pin, "Pin"],
    [Palette, "Color"],
    [Tag, "Tag"],
    [FolderInput, "Move"],
  ] as const;
  return (
    <>
      {actions.map(([Icon, label]) =>
        labels ? (
          <button
            key={label}
            type="button"
            className="flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-sidebar-accent hover:text-foreground"
          >
            <Icon className="size-3.5" />
            {label}
          </button>
        ) : (
          <IconButton key={label} label={label}>
            <Icon className="size-3.5" />
          </IconButton>
        ),
      )}
      <IconButton label="Delete" danger>
        <Trash2 className="size-3.5" />
      </IconButton>
    </>
  );
}

function SessionRows({ variant }: { variant: string }) {
  let section = "";
  return (
    <div className="px-2 pb-24">
      {sessions.map((session) => {
        const showSection = session.section !== section;
        section = session.section;
        return (
          <div key={session.id}>
            {showSection && (
              <div className="flex h-8 items-center justify-between px-2 pt-1 text-[11px] font-medium text-muted-foreground">
                <span>{session.section}</span>
                {session.section !== "Chats" && <ChevronDown className="size-3" />}
              </div>
            )}
            <button
              type="button"
              className={`group relative flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors ${session.selected ? (variant === "C" ? "bg-primary/10 text-foreground" : "bg-sidebar-accent text-foreground") : "text-muted-foreground hover:bg-sidebar-accent/70 hover:text-foreground"} ${session.active && variant !== "C" ? "font-medium" : ""}`}
            >
              {variant === "C" ? (
                <span
                  className={`flex size-4 items-center justify-center rounded border ${session.selected ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/45"}`}
                >
                  {session.selected && <Check className="size-3" />}
                </span>
              ) : (
                <MessageSquare className="size-3.5 shrink-0" />
              )}
              <span className={`size-1.5 shrink-0 rounded-full ${session.dot}`} />
              <span className="min-w-0 flex-1 truncate">{session.title}</span>
              {session.selected && variant !== "C" && <Check className="size-3.5 text-primary" />}
              {!session.selected && (
                <MoreHorizontal className="size-3.5 opacity-0 group-hover:opacity-100" />
              )}
              {session.active && (
                <span className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-primary" />
              )}
            </button>
          </div>
        );
      })}
    </div>
  );
}

function NormalHeader() {
  return (
    <div className="h-[84px] shrink-0 border-b border-sidebar-border p-2">
      <div className="flex items-center gap-1">
        <button
          type="button"
          className="flex h-8 flex-1 items-center gap-2 rounded-md px-2 text-sm font-semibold hover:bg-sidebar-accent"
        >
          <Circle className="size-4 fill-primary text-primary" />
          OpenGUI
        </button>
        <IconButton label="New chat">
          <Plus className="size-4" />
        </IconButton>
      </div>
      <div className="mt-1 flex h-8 items-center gap-2 rounded-md bg-sidebar-accent/70 px-2 text-xs text-muted-foreground">
        <Search className="size-3.5" />
        <span>Search sessions…</span>
        <kbd className="ml-auto rounded border border-sidebar-border px-1 text-[10px]">⌘K</kbd>
      </div>
    </div>
  );
}

function Sidebar({ variant }: { variant: string }) {
  return (
    <aside className="relative flex h-full w-[276px] shrink-0 flex-col overflow-hidden border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      {variant === "A" ? (
        <div className="h-[84px] shrink-0 border-b border-primary/20 bg-primary/[0.07] p-2">
          <div className="flex h-8 items-center gap-2 px-1">
            <span className="flex size-5 items-center justify-center rounded bg-primary text-[11px] font-semibold text-primary-foreground">
              3
            </span>
            <span className="flex-1 text-sm font-semibold">Sessions selected</span>
            <IconButton label="Clear selection" quiet>
              <X className="size-4" />
            </IconButton>
          </div>
          <div className="mt-1 flex items-center justify-between">
            <ActionSet />
          </div>
        </div>
      ) : (
        <NormalHeader />
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <SessionRows variant={variant} />
      </div>
      {variant === "B" && (
        <div className="absolute bottom-14 left-3 right-3 rounded-xl bg-foreground p-1.5 text-background shadow-[0_6px_8px_rgba(0,0,0,.22)]">
          <div className="flex items-center gap-0.5">
            <span className="ml-1 mr-auto text-xs font-semibold">3 selected</span>
            {[Pin, Palette, Tag, FolderInput].map((Icon, index) => (
              <button
                key={index}
                type="button"
                className="flex size-7 items-center justify-center rounded-md hover:bg-background/15"
              >
                <Icon className="size-3.5" />
              </button>
            ))}
            <button
              type="button"
              className="flex size-7 items-center justify-center rounded-md text-red-400 hover:bg-red-500/15"
            >
              <Trash2 className="size-3.5" />
            </button>
            <button
              type="button"
              className="flex size-7 items-center justify-center rounded-md hover:bg-background/15"
            >
              <X className="size-3.5" />
            </button>
          </div>
        </div>
      )}
      {variant === "C" && (
        <div className="absolute bottom-11 left-0 right-0 border-t border-sidebar-border bg-sidebar p-2">
          <div className="mb-1 flex items-center px-1">
            <span className="text-xs font-semibold">3 sessions</span>
            <button
              type="button"
              className="ml-auto text-[11px] text-muted-foreground hover:text-foreground"
            >
              Select all
            </button>
          </div>
          <div className="flex items-center">
            <ActionSet />
            <IconButton label="Close">
              <X className="size-3.5" />
            </IconButton>
          </div>
        </div>
      )}
      <div className="flex h-11 shrink-0 items-center gap-2 border-t border-sidebar-border px-3 text-xs text-muted-foreground">
        <Settings className="size-4" />
        Settings
        <span className="ml-auto size-2 rounded-full bg-emerald-500" />
      </div>
    </aside>
  );
}

function Workspace({ variant }: { variant: string }) {
  return (
    <main className="relative flex min-w-0 flex-1 flex-col bg-background">
      {variant === "D" ? (
        <div className="flex h-12 items-center gap-2 border-b border-border bg-muted/30 px-4">
          <span className="flex size-5 items-center justify-center rounded bg-primary text-[11px] font-semibold text-primary-foreground">
            3
          </span>
          <span className="mr-3 text-sm font-semibold">Selected in sidebar</span>
          <ActionSet labels />
          <button
            type="button"
            className="ml-auto text-xs text-muted-foreground hover:text-foreground"
          >
            Cancel
          </button>
        </div>
      ) : (
        <div className="flex h-12 items-center border-b border-border px-4">
          <Hash className="mr-2 size-4 text-muted-foreground" />
          <span className="text-sm font-medium">Customer email sequence</span>
          <span className="ml-2 rounded-full bg-violet-500/12 px-2 py-0.5 text-[10px] text-violet-400">
            Marketing
          </span>
          <MoreHorizontal className="ml-auto size-4 text-muted-foreground" />
        </div>
      )}
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-8 py-8">
        <div className="mb-8">
          <h1 className="text-xl font-semibold tracking-tight">Customer email sequence</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Create a concise launch sequence for existing customers.
          </p>
        </div>
        <div className="space-y-6 text-sm">
          <div className="ml-auto max-w-[76%] rounded-xl bg-muted px-4 py-3">
            Draft a three-email sequence for the launch. Keep it useful, direct, and avoid hype.
          </div>
          <div className="max-w-[82%] space-y-3">
            <p>
              I’ll structure this as an announcement, a practical use-case follow-up, and a final
              reminder.
            </p>
            <div className="rounded-lg bg-muted/50 p-4">
              <div className="mb-2 text-xs font-semibold">Email 1 — What’s new</div>
              <p className="text-muted-foreground">
                Subject: A simpler way to plan your next project
              </p>
            </div>
          </div>
        </div>
        <div className="mt-auto rounded-xl border border-border bg-card p-3">
          <div className="h-14 text-sm text-muted-foreground">Ask a follow-up…</div>
          <div className="flex items-center">
            <Plus className="size-4 text-muted-foreground" />
            <button className="ml-auto rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground">
              Send
            </button>
          </div>
        </div>
      </div>
      <div className="absolute bottom-20 right-5 w-64 rounded-lg border border-border bg-popover p-3 text-xs shadow-sm">
        <div className="mb-1 font-semibold">
          {VARIANTS.find((item) => item.key === variant)?.label}
        </div>
        <p className="leading-relaxed text-muted-foreground">
          {variant === "A"
            ? "Selection temporarily replaces search. Actions stay anchored and visible without covering rows."
            : variant === "B"
              ? "A compact dark dock preserves the normal sidebar header and floats near the selected content."
              : variant === "C"
                ? "Explicit checkboxes turn the sidebar into a clear selection mode with a stable bottom tray."
                : "Bulk actions use the main pane’s width, keeping the narrow sidebar nearly unchanged."}
        </p>
      </div>
    </main>
  );
}

export function SessionMultiSelectPrototype() {
  const initial = new URLSearchParams(window.location.search).get("variant")?.toUpperCase();
  const [variant, setVariant] = useState(
    VARIANTS.some((item) => item.key === initial) ? initial! : "A",
  );
  const changeVariant = useCallback((key: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set("variant", key);
    window.history.replaceState({}, "", url);
    setVariant(key);
  }, []);
  return (
    <div className="flex h-screen min-h-[620px] overflow-hidden bg-background text-foreground">
      <Sidebar variant={variant} />
      <Workspace variant={variant} />
      <PrototypeVariantSwitcher variants={VARIANTS} current={variant} onChange={changeVariant} />
    </div>
  );
}
