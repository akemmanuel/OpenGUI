import { AlertCircle, Loader2, Plus } from "lucide-react";
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
  arrayMove,
  horizontalListSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useCallback, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

type Workspace = { id: string; name: string };
type WorkspaceStatus =
  | { busy?: boolean; error?: unknown; needsAttention?: boolean; connected?: boolean }
  | undefined;

function SortableWorkspaceTab({
  id,
  children,
}: {
  id: string;
  children: (props: { dragProps: Record<string, unknown>; isDragging: boolean }) => React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  });
  return (
    <div
      ref={setNodeRef}
      className="relative shrink-0 overflow-visible"
      style={
        {
          WebkitAppRegion: "no-drag",
          transform: CSS.Transform.toString(transform),
          transition,
        } as React.CSSProperties
      }
    >
      {children({ dragProps: { ...attributes, ...listeners }, isDragging })}
    </div>
  );
}

export function WorkspaceTabs({
  workspaces,
  workspaceStatuses,
  activeWorkspaceId,
  canManage,
  visible,
  isMac,
  isWebRuntime,
  onSwitch,
  onReorder,
  onAdd,
  onEdit,
}: {
  workspaces: Workspace[];
  workspaceStatuses: Record<string, WorkspaceStatus>;
  activeWorkspaceId: string | null;
  canManage: boolean;
  visible: boolean;
  isMac: boolean;
  isWebRuntime: boolean;
  onSwitch: (id: string) => void;
  onReorder: (from: number, to: number) => void;
  onAdd: () => void;
  onEdit: () => void;
}) {
  const { t } = useTranslation();
  const tabsRef = useRef<HTMLDivElement>(null);
  const ids = useMemo(() => workspaces.map(({ id }) => id), [workspaces]);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      if (!event.over || event.active.id === event.over.id) return;
      const from = ids.indexOf(String(event.active.id));
      const over = ids.indexOf(String(event.over.id));
      if (from === -1 || over === -1) return;
      onReorder(from, arrayMove(ids, from, over).indexOf(String(event.active.id)));
    },
    [ids, onReorder],
  );

  return (
    <div
      className={`absolute top-[var(--app-safe-top)] h-9 ${isWebRuntime ? "left-9 right-2" : isMac ? "left-9 right-20" : "left-9 right-36"} flex items-center gap-1 px-2`}
    >
      <div
        ref={tabsRef}
        onWheel={(event) => {
          if (event.shiftKey && event.deltaY !== 0 && tabsRef.current) {
            event.preventDefault();
            tabsRef.current.scrollLeft += event.deltaY;
          }
        }}
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto scrollbar-none"
      >
        {visible && (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={ids} strategy={horizontalListSortingStrategy}>
              {workspaces.map((workspace) => {
                const status = workspaceStatuses[workspace.id];
                const active = workspace.id === activeWorkspaceId;
                return (
                  <SortableWorkspaceTab key={workspace.id} id={workspace.id}>
                    {({ dragProps, isDragging }) => (
                      <button
                        type="button"
                        {...dragProps}
                        onClick={() => onSwitch(workspace.id)}
                        onDoubleClick={(event) => {
                          event.stopPropagation();
                          onSwitch(workspace.id);
                          if (canManage) onEdit();
                        }}
                        className={`flex h-7 cursor-grab items-center gap-2 rounded-md border px-3 text-xs transition-colors whitespace-nowrap active:cursor-grabbing ${isDragging ? "opacity-60 " : ""}${active ? "border-border bg-background text-foreground" : "border-transparent bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground"}`}
                      >
                        <span className="truncate max-w-[120px]">{workspace.name}</span>
                        {status?.busy ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : status?.error ? (
                          <AlertCircle className="size-3 text-destructive" />
                        ) : status?.needsAttention ? (
                          <span className="size-2 rounded-full bg-amber-500" />
                        ) : status?.connected ? (
                          <span className="size-2 rounded-full bg-emerald-500" />
                        ) : null}
                      </button>
                    )}
                  </SortableWorkspaceTab>
                );
              })}
            </SortableContext>
          </DndContext>
        )}
        {canManage && (
          <Button
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            onClick={onAdd}
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          >
            <Plus className="size-4" />
            <span className="sr-only">{t("workspace.addWorkspace")}</span>
          </Button>
        )}
      </div>
    </div>
  );
}
