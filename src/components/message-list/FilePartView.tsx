import { useTranslation } from "react-i18next";
import { HostImage } from "@/components/HostImage";
import { useWorkspaceState } from "@/hooks/use-agent-state";
import { resolveAttachmentImageSrc } from "@/lib/attachment-src";
import type { FileTranscriptPart } from "@/protocol/session-transcript";

export function FilePartView({ part }: { part: FileTranscriptPart }) {
  const { t } = useTranslation();
  const { attachmentBaseUrl } = useWorkspaceState();
  const isImage = (part.mime ?? "").toLowerCase().startsWith("image/");
  const src = resolveAttachmentImageSrc(part.url, attachmentBaseUrl);

  if (isImage) {
    return (
      <div>
        <HostImage
          src={src}
          alt={part.filename ?? t("attachments.image")}
          className="max-h-64 max-w-full rounded-lg object-contain"
          fallbackClassName="h-8 min-w-40"
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
