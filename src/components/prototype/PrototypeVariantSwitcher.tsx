/**
 * PROTOTYPE ONLY — floating variant switcher. Do not ship.
 */
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type PrototypeVariantOption = {
  key: string;
  label: string;
};

export function PrototypeVariantSwitcher({
  variants,
  current,
  onChange,
}: {
  variants: readonly PrototypeVariantOption[];
  current: string;
  onChange: (key: string) => void;
}) {
  if (import.meta.env.PROD) return null;

  const index = Math.max(
    0,
    variants.findIndex((variant) => variant.key === current),
  );
  const active = variants[index] ?? variants[0];
  if (!active) return null;

  const cycle = (delta: number) => {
    const next = variants[(index + delta + variants.length) % variants.length];
    if (next) onChange(next.key);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      ) {
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        const next = variants[(index - 1 + variants.length) % variants.length];
        if (next) onChange(next.key);
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        const next = variants[(index + 1) % variants.length];
        if (next) onChange(next.key);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [index, onChange, variants]);

  return (
    <div
      className={cn(
        "fixed bottom-4 left-1/2 z-[100] flex -translate-x-1/2 items-center gap-2 rounded-full",
        "border border-amber-400/40 bg-zinc-950 px-2 py-1.5 text-amber-50 shadow-lg",
      )}
      role="navigation"
      aria-label="Prototype variant switcher"
    >
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        className="text-amber-50 hover:bg-amber-400/15 hover:text-amber-50"
        onClick={() => cycle(-1)}
        aria-label="Previous variant"
      >
        <ChevronLeft className="size-4" />
      </Button>
      <div className="min-w-44 px-1 text-center font-mono text-xs tracking-wide">
        <span className="text-amber-300">{active.key}</span>
        <span className="text-zinc-400"> — </span>
        <span>{active.label}</span>
      </div>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        className="text-amber-50 hover:bg-amber-400/15 hover:text-amber-50"
        onClick={() => cycle(1)}
        aria-label="Next variant"
      >
        <ChevronRight className="size-4" />
      </Button>
    </div>
  );
}
