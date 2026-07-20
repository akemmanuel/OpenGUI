import {
  Check,
  FolderOpen,
  FolderX,
  Palette,
  Pencil,
  Pin,
  PinOff,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SessionColor } from "@/hooks/use-agent-state";
import { getProjectName } from "@/lib/path";
import { SessionColorPicker } from "./SessionColorPicker";

export interface SessionMenuProps {
  pinned: boolean;
  currentColor: SessionColor | undefined;
  currentTags: string[];
  availableProjects: string[];
  displayProjectDir: string | null;
  currentProjectDir: string | null;
  onTogglePin: () => void;
  onSetColor: (color: SessionColor) => void;
  onSetTags: (tags: string[]) => void;
  onMoveToProject: (directory: string) => void;
  onRemoveFromProject: (() => void) | null;
  onRename: () => void;
  onDelete: () => void;
}

export interface SessionMenuSlots {
  item: (key: string, children: ReactNode, onSelect: () => void) => ReactNode;
  separator: (key: string) => ReactNode;
  submenu: (options: {
    key: string;
    trigger: ReactNode;
    children: ReactNode;
    contentClassName?: string;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
  }) => ReactNode;
}

export function SessionMenuContent({
  slots,
  resetKey,
  focusTagInput,
  ...props
}: SessionMenuProps & {
  slots: SessionMenuSlots;
  resetKey?: number;
  focusTagInput: boolean;
}) {
  const { t } = useTranslation();
  const [tagInput, setTagInput] = useState("");
  const [tagsOpen, setTagsOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setTagsOpen(false);
    setTagInput("");
  }, [resetKey]);

  const addTag = useCallback(() => {
    const tag = tagInput.trim();
    if (tag && !props.currentTags.includes(tag)) props.onSetTags([...props.currentTags, tag]);
    setTagInput("");
  }, [props.currentTags, props.onSetTags, tagInput]);

  const handleTagsOpenChange = (open: boolean) => {
    setTagsOpen(open);
    if (open && focusTagInput) setTimeout(() => inputRef.current?.focus(), 0);
    if (!open && focusTagInput) setTagInput("");
  };

  const colorItems = (
    <SessionColorPicker
      currentColor={props.currentColor}
      onSetColor={props.onSetColor}
      renderItem={({ key, children, onSelect }) => slots.item(key, children, onSelect)}
    />
  );
  const tagContent = (
    <>
      {props.currentTags.length > 0 && (
        <>
          <div className="flex flex-wrap gap-1 px-2 py-1.5">
            {props.currentTags.map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center gap-0.5 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
              >
                {tag}
                <button
                  type="button"
                  aria-label={t("sessionMenu.removeTag", { tag })}
                  className="ml-0.5 rounded-full p-0.5 hover:bg-accent"
                  onClick={(event) => {
                    event.stopPropagation();
                    props.onSetTags(props.currentTags.filter((candidate) => candidate !== tag));
                  }}
                >
                  <X className="size-2.5" />
                </button>
              </span>
            ))}
          </div>
          {slots.separator("tags-separator")}
        </>
      )}
      <div className="px-2 py-1.5">
        <input
          ref={inputRef}
          type="text"
          value={tagInput}
          onChange={(event) => setTagInput(event.target.value)}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") {
              event.preventDefault();
              addTag();
            }
          }}
          placeholder={t("sessionMenu.addTag")}
          className="h-7 w-full min-w-0 rounded-md border border-input bg-transparent px-2 text-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
        />
      </div>
    </>
  );

  return (
    <>
      {slots.item(
        "pin",
        <>
          {props.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
          <span>{props.pinned ? t("sessionMenu.unpin") : t("sessionMenu.pin")}</span>
        </>,
        props.onTogglePin,
      )}
      {slots.separator("after-pin")}
      {slots.item(
        "rename",
        <>
          <Pencil className="size-4" />
          <span>{t("sessionMenu.rename")}</span>
        </>,
        props.onRename,
      )}
      {slots.separator("after-rename")}
      {slots.submenu({
        key: "colors",
        trigger: (
          <>
            <Palette className="size-4" />
            <span>{t("sessionMenu.setColor")}</span>
          </>
        ),
        children: colorItems,
        contentClassName: "min-w-[10rem]",
      })}
      {slots.submenu({
        key: "tags",
        trigger: (
          <>
            <Tag className="size-4" />
            <span>{t("sessionMenu.tags")}</span>
            {props.currentTags.length > 0 && (
              <span className="ml-auto text-[10px] text-muted-foreground tabular-nums">
                {props.currentTags.length}
              </span>
            )}
          </>
        ),
        children: tagContent,
        contentClassName: "min-w-[12rem] max-w-[16rem]",
        open: tagsOpen,
        onOpenChange: handleTagsOpenChange,
      })}
      {props.availableProjects.length > 0 && (
        <>
          {slots.separator("before-projects")}
          {slots.submenu({
            key: "projects",
            trigger: (
              <>
                <FolderOpen className="size-4" />
                <span>{t("sessionMenu.moveToProject")}</span>
              </>
            ),
            contentClassName:
              "max-h-[min(24rem,calc(100vh-2rem))] min-w-[12rem] overflow-y-auto overscroll-contain",
            children: props.availableProjects.map((directory) =>
              slots.item(
                directory,
                <>
                  <span>{getProjectName(directory)}</span>
                  {props.displayProjectDir === directory && <Check className="ml-auto size-3.5" />}
                </>,
                () => props.onMoveToProject(directory),
              ),
            ),
          })}
        </>
      )}
      {props.currentProjectDir && props.onRemoveFromProject && (
        <>
          {slots.separator("before-remove-project")}
          {slots.item(
            "remove-project",
            <>
              <FolderX className="size-4" />
              <span>
                {t("sessionMenu.removeFromProject", {
                  project: getProjectName(props.currentProjectDir),
                })}
              </span>
            </>,
            props.onRemoveFromProject,
          )}
        </>
      )}
      {slots.separator("before-delete")}
      {slots.item(
        "delete",
        <>
          <Trash2 className="size-4" />
          <span>{t("sessionMenu.deleteSession")}</span>
        </>,
        props.onDelete,
      )}
    </>
  );
}
