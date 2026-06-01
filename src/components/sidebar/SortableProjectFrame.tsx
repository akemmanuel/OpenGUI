import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { ReactNode } from "react";

type SortableProjectFrameProps = {
  directory: string;
  children: (props: { dragHandleProps: Record<string, unknown> }) => ReactNode;
};

export function SortableProjectFrame({ directory, children }: SortableProjectFrameProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: directory,
  });

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: transform ? CSS.Translate.toString(transform) : undefined,
        transition,
      }}
      className={isDragging ? "relative z-10 opacity-60" : undefined}
    >
      {children({ dragHandleProps: { ...attributes, ...listeners } })}
    </div>
  );
}
