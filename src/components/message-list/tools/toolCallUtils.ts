import type { ToolCallState } from "@/protocol/session-transcript";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function getToolInput(state: ToolCallState): Record<string, unknown> | null {
  return "input" in state && isRecord(state.input) ? state.input : null;
}

export function stringField(record: Record<string, unknown> | null | undefined, key: string) {
  const value = record?.[key];
  return typeof value === "string" ? value : null;
}

export function toFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function prettifyToolName(rawName: string): string {
  return (
    rawName
      .split(/[_\s-]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ") || rawName
  );
}
