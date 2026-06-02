import type { Command } from "@opencode-ai/sdk/v2/client";
import * as React from "react";
import { useFilteredCommands } from "@/components/SlashCommandPopover";

export function parseSlashCommand(
  value: string,
  commands: Command[],
): { commandName: string; args: string; command: Command } | null {
  if (!value.startsWith("/")) return null;
  const trimmed = value.trim();
  const spaceIndex = trimmed.indexOf(" ");
  const commandName = spaceIndex > 0 ? trimmed.slice(1, spaceIndex) : trimmed.slice(1);
  const args = spaceIndex > 0 ? trimmed.slice(spaceIndex + 1) : "";
  const command = commands.find((candidate) => candidate.name === commandName);
  return command ? { commandName, args, command } : null;
}

export function useSlashCommandInput({
  enabled,
  commands,
  setValue,
  textareaRef,
}: {
  enabled: boolean;
  commands: Command[];
  setValue: (value: string) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const [open, setOpen] = React.useState(false);
  const [filter, setFilter] = React.useState("");
  const [activeIndex, setActiveIndex] = React.useState(0);
  const filteredCommands = useFilteredCommands(commands, filter);

  const reset = React.useCallback(() => {
    setOpen(false);
    setFilter("");
    setActiveIndex(0);
  }, []);

  const updateForInput = React.useCallback(
    (value: string) => {
      const slashMatch = value.match(/^\/(\S*)$/);
      if (enabled && slashMatch) {
        setFilter(slashMatch[1] ?? "");
        setActiveIndex(0);
        setOpen(true);
        return;
      }
      setOpen(false);
    },
    [enabled],
  );

  const select = React.useCallback(
    (cmd: Command) => {
      setValue(`/${cmd.name} `);
      setOpen(false);
      textareaRef.current?.focus();
    },
    [setValue, textareaRef],
  );

  const parse = React.useCallback(
    (value: string) => (enabled ? parseSlashCommand(value, commands) : null),
    [commands, enabled],
  );

  return {
    open,
    filter,
    activeIndex,
    setActiveIndex,
    filteredCommands,
    updateForInput,
    select,
    reset,
    parse,
  };
}
