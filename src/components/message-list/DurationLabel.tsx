import { useEffect, useState } from "react";
import { formatWholeSecondDuration } from "./duration";
import type { TurnFooter } from "./types";

export function DurationLabel({ footer }: { footer: TurnFooter }) {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!footer.running || typeof footer.startedAt !== "number") return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [footer.running, footer.startedAt]);

  const endedAt = footer.running ? nowMs : footer.completedAt;
  const elapsed =
    typeof footer.startedAt === "number" && typeof endedAt === "number"
      ? endedAt - footer.startedAt
      : null;
  if (typeof elapsed !== "number" || !Number.isFinite(elapsed) || elapsed <= 0) return null;

  return <span>{formatWholeSecondDuration(elapsed)}</span>;
}
