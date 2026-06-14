import type { FilePart } from "@opencode-ai/sdk/v2/client";
import { useTranslation } from "react-i18next";
import { useConnectionState } from "@/hooks/use-agent-state";
import { resolveAttachmentImageSrc } from "@/lib/attachment-src";

export function FilePartView({ part }: { part: FilePart }) {
  const { t } = useTranslation();
  const { workspaceServerUrl } = useConnectionState();
  const isImage = (part.mime ?? "").toLowerCase().startsWith("image/");
  const src = resolveAttachmentImageSrc(part.url, workspaceServerUrl);

  if (isImage) {
    return (
      <div>
        <img
          src={src}
          alt={part.filename ?? t("attachments.image")}
          className="max-h-64 max-w-full rounded-lg object-contain"
        />
        {part.filename && (
          <p className="text-xs text-muted-foreground mt-1 truncate">{part.filename}</p>
        )}
      </div>
    );
  }

  return (
    <div className="text-sm text-muted-foreground italic">
      {part.filename ?? t("attachments.fileAttachment")}
    </div>
  );
}
