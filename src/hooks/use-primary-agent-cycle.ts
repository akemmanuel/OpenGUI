export function getNextPrimaryAgent({
  primaryAgents,
  selectedAgent,
  shiftKey = false,
}: {
  primaryAgents: string[];
  selectedAgent: string | null | undefined;
  shiftKey?: boolean;
}): string | null {
  if (primaryAgents.length === 0) return selectedAgent ?? null;
  const effective = selectedAgent ?? "build";
  const currentIndex = primaryAgents.indexOf(effective);
  const idx = currentIndex === -1 ? 0 : currentIndex;
  const nextIndex = shiftKey
    ? (idx - 1 + primaryAgents.length) % primaryAgents.length
    : (idx + 1) % primaryAgents.length;
  const nextAgent = primaryAgents[nextIndex];
  return nextAgent === "build" ? null : (nextAgent ?? null);
}
