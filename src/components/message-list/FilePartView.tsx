import type { FilePart } from "@opencode-ai/sdk/v2/client";
import { useConnectionState } from "@/hooks/use-agent-state";
import { resolveAttachmentImageSrc } from "@/lib/attachment-src";

export function FilePartView({ part }: { part: FilePart }) {
  const { workspaceServerUrl } = useConnectionState();
  const isImage = (part.mime ?? "").toLowerCase().startsWith("image/");
  const src = resolveAttachmentImageSrc(part.url, workspaceServerUrl);

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
