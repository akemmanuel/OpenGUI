import { ImageOff } from "lucide-react";
import * as React from "react";
import { useContext } from "react";
import { useTranslation } from "react-i18next";
import { WorkspaceContext } from "@/hooks/agent-contexts";
import { isAttachmentHostUrl } from "@/lib/attachment-src";
import { cn } from "@/lib/utils";

type HostImageState = { src: string | null; failed: boolean };

/**
 * Blob URLs share the app's origin, and an SVG opened from one runs script
 * there. Only raster images become blobs; anything else shows as unavailable.
 */
const RASTER_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
]);

/**
 * `<img>` cannot send an Authorization header, so token-authenticated Remote
 * Hosts are fetched with the bearer credential and shown from a blob URL.
 * Desktop Local, cookie-authenticated Hosts, and URLs on any other origin
 * keep the plain request: the credential never leaves the Host's origin.
 */
function useHostImageSrc(
  src: string,
  token: string | null,
  baseUrl: string | null,
): HostImageState {
  const needsFetch = Boolean(token) && isAttachmentHostUrl(src, baseUrl);
  const [state, setState] = React.useState<HostImageState>(() =>
    needsFetch ? { src: null, failed: false } : { src, failed: false },
  );

  React.useEffect(() => {
    if (!needsFetch) {
      setState({ src, failed: false });
      return;
    }
    let objectUrl: string | null = null;
    const controller = new AbortController();
    setState({ src: null, failed: false });
    fetch(src, {
      headers: { authorization: `Bearer ${token}` },
      credentials: "include",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Image request failed (${response.status})`);
        const blob = await response.blob();
        const type = blob.type.split(";")[0]!.trim().toLowerCase();
        if (!RASTER_IMAGE_TYPES.has(type)) throw new Error(`Unsupported image type (${type})`);
        objectUrl = URL.createObjectURL(blob);
        setState({ src: objectUrl, failed: false });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ src: null, failed: true });
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [needsFetch, src, token]);

  return state;
}

export function HostImage({
  src,
  alt,
  className,
  fallbackClassName,
  loading,
}: {
  src: string;
  alt: string;
  className?: string;
  fallbackClassName?: string;
  loading?: "lazy" | "eager";
}) {
  const { t } = useTranslation();
  const workspace = useContext(WorkspaceContext);
  const image = useHostImageSrc(
    src,
    workspace?.attachmentAuthToken ?? null,
    workspace?.attachmentBaseUrl ?? null,
  );
  const [loadFailed, setLoadFailed] = React.useState(false);

  React.useEffect(() => setLoadFailed(false), [image.src]);

  if (image.failed || loadFailed) {
    return (
      <span
        role="img"
        aria-label={alt}
        title={alt}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md border border-dashed border-border px-2 py-1 text-xs text-muted-foreground",
          fallbackClassName,
        )}
      >
        <ImageOff className="size-3.5 shrink-0" />
        <span className="truncate">{t("attachments.imageUnavailable")}</span>
      </span>
    );
  }
  if (!image.src) {
    return (
      <span
        aria-hidden
        className={cn("inline-block animate-pulse rounded-md bg-muted", fallbackClassName)}
      />
    );
  }
  return (
    <img
      src={image.src}
      alt={alt}
      loading={loading}
      className={className}
      onError={() => setLoadFailed(true)}
    />
  );
}
