/** Shared IPC string coercion for harness bridge setup modules. */

export function asOptionalHarnessIpcString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asRequiredHarnessIpcString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
  return value;
}
