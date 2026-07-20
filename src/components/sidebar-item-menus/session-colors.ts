import type { SessionColor } from "@/hooks/use-agent-state";

export const SESSION_COLORS: ReadonlyArray<{
  value: SessionColor;
  labelKey: `sessionMenu.colors.${string}`;
  swatchClassName: string;
  borderClassName: string;
}> = [
  {
    value: null,
    labelKey: "sessionMenu.colors.none",
    swatchClassName: "bg-transparent border border-muted-foreground/30",
    borderClassName: "border-sidebar-border",
  },
  {
    value: "red",
    labelKey: "sessionMenu.colors.red",
    swatchClassName: "bg-red-500",
    borderClassName: "border-red-500",
  },
  {
    value: "orange",
    labelKey: "sessionMenu.colors.orange",
    swatchClassName: "bg-orange-500",
    borderClassName: "border-orange-500",
  },
  {
    value: "yellow",
    labelKey: "sessionMenu.colors.yellow",
    swatchClassName: "bg-yellow-500",
    borderClassName: "border-yellow-500",
  },
  {
    value: "green",
    labelKey: "sessionMenu.colors.green",
    swatchClassName: "bg-green-500",
    borderClassName: "border-green-500",
  },
  {
    value: "blue",
    labelKey: "sessionMenu.colors.blue",
    swatchClassName: "bg-blue-500",
    borderClassName: "border-blue-500",
  },
  {
    value: "purple",
    labelKey: "sessionMenu.colors.purple",
    swatchClassName: "bg-purple-500",
    borderClassName: "border-purple-500",
  },
  {
    value: "pink",
    labelKey: "sessionMenu.colors.pink",
    swatchClassName: "bg-pink-500",
    borderClassName: "border-pink-500",
  },
  {
    value: "gray",
    labelKey: "sessionMenu.colors.gray",
    swatchClassName: "bg-gray-500",
    borderClassName: "border-gray-500",
  },
];

export function getSessionColorBorderClass(color: SessionColor | undefined): string {
  return (
    SESSION_COLORS.find((candidate) => candidate.value === (color ?? null))?.borderClassName ??
    "border-sidebar-border"
  );
}
