import * as React from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { resolveAttachmentImageSrc } from "@/lib/attachment-src";
import { cn } from "@/lib/utils";

export type ImageMention = {
  path: string;
  filename: string;
};

function ImageLightbox({
  image,
  serverUrl,
  baseDirectory,
  onClose,
}: {
  image: ImageMention;
  serverUrl?: string | null;
  baseDirectory?: string | null;
  onClose: () => void;
}) {
  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const src = resolveAttachmentImageSrc(image.path, serverUrl, baseDirectory);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative max-h-full max-w-full rounded-xl bg-popover p-3 shadow-2xl ring-1 ring-foreground/10"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          className="absolute right-2 top-2 rounded-full bg-background/90 p-1.5 text-muted-foreground shadow-sm hover:text-foreground"
          onClick={onClose}
          aria-label="Close image preview"
        >
          <X className="size-4" />
        </button>
        <img
          src={src}
          alt={image.filename}
          className="max-h-[80vh] max-w-[90vw] rounded-lg object-contain"
        />
        <div className="mt-2 max-w-[90vw] truncate text-xs text-muted-foreground">{image.path}</div>
      </div>
    </div>,
    document.body,
  );
}

export function ImageMentionToken({
  token,
  image,
  serverUrl,
  baseDirectory,
  active,
  onHover,
  onOpen,
}: {
  token: string;
  image: ImageMention;
  serverUrl?: string | null;
  baseDirectory?: string | null;
  active?: boolean;
  onHover?: (path: string | null) => void;
  onOpen?: (image: ImageMention) => void;
}) {
  const [localOpenImage, setLocalOpenImage] = React.useState<ImageMention | null>(null);

  return (
    <>
      <button
        type="button"
        className={cn(
          "inline rounded-sm text-primary underline decoration-primary/40 underline-offset-2 transition-all hover:bg-primary/10 focus:bg-primary/10 focus:outline-none",
          active && "bg-primary/15 decoration-primary ring-1 ring-primary/30",
        )}
        onMouseEnter={() => onHover?.(image.path)}
        onMouseLeave={() => onHover?.(null)}
        onFocus={() => onHover?.(image.path)}
        onBlur={() => onHover?.(null)}
        onClick={() => (onOpen ? onOpen(image) : setLocalOpenImage(image))}
      >
        {token}
      </button>
      {localOpenImage && (
        <ImageLightbox
          image={localOpenImage}
          serverUrl={serverUrl}
          baseDirectory={baseDirectory}
          onClose={() => setLocalOpenImage(null)}
        />
      )}
    </>
  );
}

export function ImageMentionThumbnails({
  images,
  serverUrl,
  baseDirectory,
  activePath,
  onHover,
  onOpen,
  className,
}: {
  images: ImageMention[];
  serverUrl?: string | null;
  baseDirectory?: string | null;
  activePath?: string | null;
  onHover?: (path: string | null) => void;
  onOpen?: (image: ImageMention) => void;
  className?: string;
}) {
  const [localOpenImage, setLocalOpenImage] = React.useState<ImageMention | null>(null);
  if (images.length === 0) return null;

  return (
    <>
      <div className={cn("flex flex-wrap gap-2", className)}>
        {images.map((image) => {
          const src = resolveAttachmentImageSrc(image.path, serverUrl, baseDirectory);
          const active = activePath === image.path;
          return (
            <button
              key={image.path}
              type="button"
              className={cn(
                "group overflow-hidden rounded-lg border bg-background/60 p-0.5 transition-all hover:scale-[1.03] hover:border-primary/60 focus:outline-none focus:ring-2 focus:ring-primary/40",
                active && "scale-[1.06] border-primary shadow-md ring-2 ring-primary/30",
              )}
              title={image.path}
              onMouseEnter={() => onHover?.(image.path)}
              onMouseLeave={() => onHover?.(null)}
              onFocus={() => onHover?.(image.path)}
              onBlur={() => onHover?.(null)}
              onClick={() => (onOpen ? onOpen(image) : setLocalOpenImage(image))}
            >
              <img src={src} alt={image.filename} className="h-16 w-16 rounded-md object-cover" />
            </button>
          );
        })}
      </div>
      {localOpenImage && (
        <ImageLightbox
          image={localOpenImage}
          serverUrl={serverUrl}
          baseDirectory={baseDirectory}
          onClose={() => setLocalOpenImage(null)}
        />
      )}
    </>
  );
}

export function ImageMentionLightbox({
  image,
  serverUrl,
  baseDirectory,
  onClose,
}: {
  image: ImageMention | null;
  serverUrl?: string | null;
  baseDirectory?: string | null;
  onClose: () => void;
}) {
  if (!image) return null;
  return (
    <ImageLightbox
      image={image}
      serverUrl={serverUrl}
      baseDirectory={baseDirectory}
      onClose={onClose}
    />
  );
}
