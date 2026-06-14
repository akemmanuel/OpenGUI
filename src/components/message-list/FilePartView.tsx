import type { FilePart } from "@opencode-ai/sdk/v2/client";
import { resolveAttachmentImageSrc } from "@/lib/attachment-src";

export function FilePartView({
  part,
  imageServerUrl,
  imageAuthToken,
}: {
  part: FilePart;
  imageServerUrl?: string | null;
  imageAuthToken?: string | null;
}) {
  const isImage = (part.mime ?? "").toLowerCase().startsWith("image/");
  const src = resolveAttachmentImageSrc(part.url, imageServerUrl, null, imageAuthToken);

  if (isImage) {
    return (
      <div>
        <img
          src={src}
          alt={part.filename ?? "Image"}
          className="max-h-64 max-w-full rounded-lg object-contain"
        />
        {part.filename && (
          <p className="text-xs text-muted-foreground mt-1 truncate">{part.filename}</p>
        )}
      </div>
    );
  }

  return (
    <div className="text-sm text-muted-foreground italic">{part.filename ?? "File attachment"}</div>
  );
}
