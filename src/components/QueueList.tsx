import {
  ArrowDownToLine,
  ArrowUpToLine,
  ChevronDown,
  Ellipsis,
  GripVertical,
  Pencil,
  Send,
  Trash2,
} from "lucide-react";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ActorAttribution } from "@/features/identity/ActorAttribution";
import { cn } from "@/lib/utils";
import type { ActorSnapshot } from "@/protocol/host-types";

interface QueueItem {
  id: string;
  text: string;
  variant?: string;
  agent?: string;
  mode?: string;
  actor?: ActorSnapshot;
}

interface QueueListProps {
  items: QueueItem[];
  running?: boolean;
  onRemove?: (id: string) => void;
  onMoveUp?: (index: number) => void;
  onMoveDown?: (index: number) => void;
  onMoveToTop?: (index: number) => void;
  onMoveToBottom?: (index: number) => void;
  onEdit?: (id: string, newText: string) => void;
  onSendNow?: (id: string) => void;
  onReorder?: (fromIndex: number, toIndex: number) => void;
}

export function QueueDragHandle({
  label,
  dragHandleProps,
}: {
  label: string;
  dragHandleProps?: Record<string, unknown>;
}) {
  return (
    <button
      {...dragHandleProps}
      type="button"
      className="grid size-7 shrink-0 cursor-grab place-items-center rounded text-muted-foreground active:cursor-grabbing focus-visible:outline-2 focus-visible:outline-ring"
      aria-label={label}
    >
      <GripVertical className="size-3.5" />
    </button>
  );
}

function QueueItemRow({
  item,
  index,
  total,
  running,
  dragHandleProps,
  onRemove,
  onMoveUp: _onMoveUp,
  onMoveDown: _onMoveDown,
  onMoveToTop,
  onMoveToBottom,
  onEdit,
  onSendNow,
}: {
  item: QueueItem;
  index: number;
  total: number;
  running: boolean;
  onRemove?: (id: string) => void;
  onMoveUp?: (index: number) => void;
  onMoveDown?: (index: number) => void;
  onMoveToTop?: (index: number) => void;
  onMoveToBottom?: (index: number) => void;
  onEdit?: (id: string, newText: string) => void;
  onSendNow?: (id: string) => void;
  dragHandleProps?: Record<string, unknown>;
}) {
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [expanded, setExpanded] = React.useState(false);
  const [editValue, setEditValue] = React.useState(item.text);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  const menuId = React.useId();
  const { t } = useTranslation();
  const rowRef = React.useRef<HTMLDivElement>(null);

  const isFirst = index === 0;
  const isLast = index === total - 1;
  const showSendLabel = running || isFirst;
  const sendLabel = t(running ? "queueList.stopAndSend" : "queueList.sendNow");

  // Close menu on outside click
  React.useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [menuOpen]);

  // Position menu - render below first, then adjust if needed
  const [menuCoords, setMenuCoords] = React.useState<{ top: number; left: number }>({
    top: 0,
    left: 0,
  });
  React.useEffect(() => {
    if (!menuOpen || !buttonRef.current) return;
    const button = buttonRef.current.getBoundingClientRect();
    const top = button.bottom + 8;
    const left = button.right - 160;
    setMenuCoords({ top, left });
    requestAnimationFrame(() => {
      if (!menuRef.current || !buttonRef.current) return;
      const button = buttonRef.current.getBoundingClientRect();
      const menu = menuRef.current.getBoundingClientRect();
      const padding = 8;
      const menuHeight = menu.height;
      const menuWidth = menu.width;
      const spaceBelow = window.innerHeight - button.bottom;
      const spaceAbove = button.top;
      let newTop: number;
      if (spaceBelow >= menuHeight + padding || spaceBelow >= spaceAbove) {
        newTop = button.bottom + padding;
      } else if (spaceAbove >= menuHeight + padding) {
        newTop = button.top - menuHeight - padding;
      } else {
        newTop = button.bottom + padding;
      }
      let newLeft = button.right - menuWidth;
      if (newLeft < padding) newLeft = padding;
      if (newLeft + menuWidth > window.innerWidth - padding) {
        newLeft = window.innerWidth - menuWidth - padding;
      }
      setMenuCoords({ top: newTop, left: newLeft });
      menuRef.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    });
  }, [menuOpen]);

  const closeMenuAndRestoreFocus = () => {
    setMenuOpen(false);
    requestAnimationFrame(() => buttonRef.current?.focus());
  };

  const handleEditSave = () => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== item.text) {
      onEdit?.(item.id, trimmed);
    }
    setEditing(false);
    requestAnimationFrame(() => buttonRef.current?.focus());
  };

  const cancelEdit = () => {
    setEditValue(item.text);
    setEditing(false);
    requestAnimationFrame(() => buttonRef.current?.focus());
  };

  return (
    <div
      ref={rowRef}
      className={cn(
        "group flex items-center gap-1 px-2 py-1 rounded-md max-md:grid max-md:grid-cols-[auto_minmax(0,1fr)]",
        "hover:bg-accent/50 transition-colors",
      )}
    >
      {dragHandleProps ? (
        <QueueDragHandle
          label={t("queueList.reorderQueuedPrompt")}
          dragHandleProps={dragHandleProps}
        />
      ) : (
        <span aria-hidden="true" className="w-7 shrink-0" />
      )}

      {editing ? (
        <input
          type="text"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleEditSave();
            if (e.key === "Escape") cancelEdit();
          }}
          onBlur={handleEditSave}
          className="flex-1 min-w-0 bg-transparent border border-border rounded px-1.5 py-0.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          // biome-ignore lint/a11y/noAutofocus: editing mode requires immediate focus
          autoFocus
        />
      ) : (
        <div className="flex min-w-0 flex-1 flex-col">
          <ActorAttribution actor={item.actor} className="leading-4" />
          <button
            type="button"
            aria-expanded={expanded}
            title={t(expanded ? "queueList.collapseMessage" : "queueList.expandMessage")}
            onClick={() => setExpanded((current) => !current)}
            className="flex w-full min-w-0 items-start gap-1 rounded-sm py-0.5 text-left text-sm text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
          >
            <span
              className={cn(
                "min-w-0 wrap-anywhere",
                expanded ? "whitespace-pre-wrap" : "line-clamp-2 md:line-clamp-1",
              )}
            >
              {isFirst && (
                <>
                  <span className="mr-1 text-xs font-semibold text-primary">
                    {t("queueList.next")}
                  </span>{" "}
                </>
              )}
              <span>{item.text}</span>
            </span>
            <ChevronDown
              className={cn("mt-1 size-3 shrink-0 text-muted-foreground", expanded && "rotate-180")}
            />
          </button>
        </div>
      )}

      {/* Show snapshotted variant / agent / mode badges */}
      {(item.variant || item.agent || (item.mode && item.mode !== "queue")) && !editing && (
        <span className="shrink-0 flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground max-md:col-start-2">
          {item.mode && item.mode !== "queue" && (
            <span
              className={cn(
                "rounded px-1 py-px",
                item.mode === "interrupt"
                  ? "bg-destructive/15 text-destructive"
                  : "bg-amber-500/15 text-amber-600 dark:text-amber-400",
              )}
            >
              {item.mode === "interrupt" ? t("queueList.interrupt") : t("queueList.steer")}
            </span>
          )}
          {item.variant && (
            <span className="rounded bg-muted px-1 py-px capitalize">{item.variant}</span>
          )}
          {item.agent && <span className="rounded bg-muted px-1 py-px">{item.agent}</span>}
        </span>
      )}

      {!editing && (
        <div className="flex shrink-0 items-center gap-0.5 max-md:col-start-2 max-md:justify-end">
          <Button
            type="button"
            variant="ghost"
            size={showSendLabel ? "sm" : "icon-sm"}
            onClick={(e) => {
              e.stopPropagation();
              onSendNow?.(item.id);
            }}
            className={
              showSendLabel
                ? running
                  ? "text-amber-800 hover:bg-destructive/10 hover:text-destructive focus-visible:text-destructive dark:text-amber-300"
                  : "text-primary"
                : "max-md:size-9 text-muted-foreground hover:text-foreground"
            }
            title={sendLabel}
            aria-label={sendLabel}
          >
            <Send className="size-3" />
            {showSendLabel && t(running ? "queueList.stopAndSendCompact" : "queueList.sendNow")}
          </Button>

          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={(e) => {
              e.stopPropagation();
              onRemove?.(item.id);
            }}
            className="max-md:size-9 text-muted-foreground hover:text-destructive"
            aria-label={t("queueList.remove")}
            title={t("queueList.remove")}
          >
            <Trash2 className="size-3" />
          </Button>

          <div className="relative">
            <Button
              ref={buttonRef}
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={(e) => {
                e.stopPropagation();
                setMenuOpen((v) => !v);
              }}
              className="max-md:size-9 text-muted-foreground hover:text-foreground"
              aria-label={t("queueList.moreActions")}
              title={t("queueList.moreActions")}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-controls={menuOpen ? menuId : undefined}
            >
              <Ellipsis className="size-3" />
            </Button>

            {menuOpen && (
              <div
                id={menuId}
                ref={menuRef}
                role="menu"
                className="fixed z-50 min-w-[140px] rounded-md border bg-popover p-1 shadow-md"
                style={{ top: menuCoords.top, left: menuCoords.left }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    closeMenuAndRestoreFocus();
                  }
                }}
              >
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1 text-xs hover:bg-accent transition-colors text-left"
                  onClick={() => {
                    setMenuOpen(false);
                    setMenuCoords({ top: 0, left: 0 });
                    setEditValue(item.text);
                    setEditing(true);
                  }}
                >
                  <Pencil className="size-3" />
                  {t("queueList.edit")}
                </button>
                {!isFirst && (
                  <button
                    type="button"
                    role="menuitem"
                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1 text-xs hover:bg-accent transition-colors text-left"
                    onClick={() => {
                      setMenuOpen(false);
                      setMenuCoords({ top: 0, left: 0 });
                      onMoveToTop?.(index);
                    }}
                  >
                    <ArrowUpToLine className="size-3" />
                    {t("queueList.moveToTop")}
                  </button>
                )}
                {!isLast && (
                  <button
                    type="button"
                    role="menuitem"
                    className="flex w-full items-center gap-2 rounded-sm px-2 py-1 text-xs hover:bg-accent transition-colors text-left"
                    onClick={() => {
                      setMenuOpen(false);
                      setMenuCoords({ top: 0, left: 0 });
                      onMoveToBottom?.(index);
                    }}
                  >
                    <ArrowDownToLine className="size-3" />
                    {t("queueList.moveToBottom")}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SortableQueueItem({
  id,
  children,
}: {
  id: string;
  children: (props: {
    dragHandleProps: Record<string, unknown>;
    isDragging: boolean;
  }) => React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
      className={isDragging ? "relative z-10 opacity-60" : undefined}
    >
      {children({ dragHandleProps: { ...attributes, ...listeners }, isDragging })}
    </div>
  );
}

export function QueueList({
  items,
  running = false,
  onRemove,
  onMoveUp,
  onMoveDown,
  onMoveToTop,
  onMoveToBottom,
  onEdit,
  onSendNow,
  onReorder,
}: QueueListProps) {
  const { t } = useTranslation();
  const listId = React.useId();
  const [expanded, setExpanded] = React.useState(true);
  const showAll = expanded || items.length === 1;
  const visibleItems = showAll ? items : items.slice(0, 1);
  const itemIds = React.useMemo(() => items.map((item) => item.id), [items]);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const handleDragEnd = React.useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      const fromIndex = itemIds.indexOf(String(active.id));
      const toIndex = itemIds.indexOf(String(over.id));
      if (fromIndex === -1 || toIndex === -1) return;
      onReorder?.(fromIndex, toIndex);
    },
    [itemIds, onReorder],
  );

  if (items.length === 0) return null;

  return (
    <section
      aria-label={t("queueList.title", { count: items.length })}
      className="border-y border-border"
    >
      <div className="flex flex-wrap items-center justify-between gap-1 px-2 py-2">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <h2 className="text-xs font-semibold tabular-nums">
            {t("queueList.title", { count: items.length })}
          </h2>
          <p className="text-xs text-muted-foreground">
            {t(running ? "queueList.waitingForRun" : "queueList.paused")}
          </p>
        </div>
        {items.length > 1 && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            title={t(expanded ? "queueList.collapse" : "queueList.expand")}
            aria-label={t(expanded ? "queueList.collapse" : "queueList.expand")}
            aria-expanded={expanded}
            aria-controls={listId}
            onClick={() => setExpanded((value) => !value)}
          >
            <ChevronDown className={expanded ? "rotate-180" : undefined} />
          </Button>
        )}
      </div>
      <div id={listId} className="flex max-h-[min(10rem,22dvh)] flex-col divide-y overflow-y-auto">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
            {visibleItems.map((item, idx) => (
              <SortableQueueItem key={item.id} id={item.id}>
                {({ dragHandleProps }) => (
                  <QueueItemRow
                    item={item}
                    index={idx}
                    total={items.length}
                    running={running}
                    dragHandleProps={showAll ? dragHandleProps : undefined}
                    onRemove={onRemove}
                    onMoveUp={onMoveUp}
                    onMoveDown={onMoveDown}
                    onMoveToTop={onMoveToTop}
                    onMoveToBottom={onMoveToBottom}
                    onEdit={onEdit}
                    onSendNow={onSendNow}
                  />
                )}
              </SortableQueueItem>
            ))}
          </SortableContext>
        </DndContext>
      </div>
    </section>
  );
}
