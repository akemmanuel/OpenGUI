import { useEffect, useState } from "react";
import { formatWholeSecondDuration } from "./duration";
import type { TurnFooter } from "./types";

export function DurationLabel({ footer }: { footer: TurnFooter }) {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!footer.running || typeof footer.startedAt !== "number") return;
    const startedAt = footer.startedAt;
    let timer: number | null = null;

    const tick = () => {
      const now = Date.now();
      setNowMs(now);
      const elapsed = Math.max(0, now - startedAt);
      const nextSecondIn = 1000 - (elapsed % 1000);
      timer = window.setTimeout(tick, Math.max(50, nextSecondIn));
    };

    tick();
    return () => {
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [footer.running, footer.startedAt]);

  const elapsed =
    typeof footer.durationMs === "number"
      ? footer.durationMs
      : typeof footer.startedAt === "number"
        ? (footer.completedAt ?? nowMs) - footer.startedAt
        : null;
  if (typeof elapsed !== "number" || !Number.isFinite(elapsed) || elapsed <= 0) return null;

  return <span>{formatWholeSecondDuration(elapsed)}</span>;
}
