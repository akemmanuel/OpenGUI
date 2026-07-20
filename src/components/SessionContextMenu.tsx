import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import * as ContextMenu from "@/components/ui/context-menu";
import {
  SessionMenuContent,
  type SessionMenuProps,
  type SessionMenuSlots,
} from "@/components/sidebar-item-menus/SessionMenuContent";
import { getSessionColorBorderClass } from "@/components/sidebar-item-menus/session-colors";
import { CTX_ITEM_CLASS, CTX_SEPARATOR_CLASS, CTX_SUBTRIGGER_CLASS } from "@/lib/constants";

export const getColorBorderClass = getSessionColorBorderClass;

export function SessionContextMenu({
  children,
  ...props
}: SessionMenuProps & { children: ReactNode }) {
  const [resetKey, setResetKey] = useState(0);
  const slots = useMemo<SessionMenuSlots>(
    () => ({
      item: (key, content, onSelect) => (
        <ContextMenu.Item key={key} className={CTX_ITEM_CLASS} onClick={onSelect}>
          {content}
        </ContextMenu.Item>
      ),
      separator: (key) => <ContextMenu.Separator key={key} className={CTX_SEPARATOR_CLASS} />,
      submenu: ({ key, trigger, children: content, contentClassName, ...subProps }) => (
        <ContextMenu.Sub key={key} {...subProps}>
          <ContextMenu.SubTrigger className={CTX_SUBTRIGGER_CLASS}>
            {trigger}
          </ContextMenu.SubTrigger>
          <ContextMenu.SubContent className={contentClassName} sideOffset={4}>
            {content}
          </ContextMenu.SubContent>
        </ContextMenu.Sub>
      ),
    }),
    [],
  );

  return (
    <ContextMenu.Root
      onOpenChange={(open) => {
        if (!open) setResetKey((key) => key + 1);
      }}
    >
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Content
        className="min-w-[12rem]"
        alignOffset={5}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <SessionMenuContent {...props} slots={slots} resetKey={resetKey} focusTagInput={false} />
      </ContextMenu.Content>
    </ContextMenu.Root>
  );
}
