import * as React from "react";
import { createPortal } from "react-dom";
import { resolveAttachmentImageSrc } from "@/lib/attachment-src";

export function ImageMentionPreview({
  token,
  path,
  filename,
  serverUrl,
}: {
  token: string;
  path: string;
  filename: string;
  serverUrl?: string | null;
}) {
  const triggerRef = React.useRef<HTMLSpanElement>(null);
  const [open, setOpen] = React.useState(false);
  const [position, setPosition] = React.useState<{ top: number; left: number } | null>(null);
  const src = resolveAttachmentImageSrc(path, serverUrl);

  React.useLayoutEffect(() => {
    if (!open) return;

    const updatePosition = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      setPosition({
        top: Math.max(8, rect.top - 8),
        left: Math.min(Math.max(8, rect.left), window.innerWidth - 320),
      });
    };

    updatePosition();
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);
    return () => {
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
    };
  }, [open]);

  return (
    <>
      <span
        ref={triggerRef}
        tabIndex={0}
        className="cursor-zoom-in rounded-sm text-primary underline decoration-primary/40 underline-offset-2 hover:bg-primary/10 focus:bg-primary/10 focus:outline-none"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        {token}
      </span>
      {open && position
        ? createPortal(
            <div
              className="pointer-events-none fixed z-50 w-auto max-w-[min(28rem,90vw)] -translate-y-full rounded-lg bg-popover p-2 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10"
              style={{ top: position.top, left: position.left }}
            >
              <img
                src={src}
                alt={filename}
                className="max-h-80 max-w-full rounded-md object-contain"
              />
              <div className="mt-1 max-w-80 truncate text-xs text-muted-foreground">{filename}</div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
