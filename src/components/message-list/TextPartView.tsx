import type { TextPart } from "@opencode-ai/sdk/v2/client";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import { useConnectionState } from "@/hooks/use-agent-state";
import { resolveAttachmentImageSrc } from "@/lib/attachment-src";

function splitUserImageMentions(text: string): {
  text: string;
  images: Array<{ url: string; filename: string }>;
} {
  const images: Array<{ url: string; filename: string }> = [];
  const cleaned = text
    .replace(/(^|\s)@(\S+\.(?:png|jpe?g|webp|gif))(?=\s|$)/gi, (_match, prefix, url) => {
      images.push({
        url,
        filename: url.split(/[\\/]/).pop() || "Image",
      });
      return prefix;
    })
    .replace(/[ \t]{2,}/g, " ")
    .trim();

  return { text: cleaned, images };
}

export function TextPartView({ part, isUser }: { part: TextPart; isUser?: boolean }) {
  const { isLocalWorkspace, workspaceServerUrl } = useConnectionState();
  if (!part.text) return null;

  if (isUser) {
    const content = splitUserImageMentions(part.text);
    return (
      <div className="flex flex-col gap-2">
        {content.text && (
          <div className="text-sm whitespace-pre-wrap break-words select-text">{content.text}</div>
        )}
        {content.images.map((image) => (
          <img
            key={image.url}
            src={resolveAttachmentImageSrc(image.url, isLocalWorkspace ? null : workspaceServerUrl)}
            alt={image.filename}
            className="max-h-64 max-w-full rounded-lg object-contain"
          />
        ))}
      </div>
    );
  }

  return (
    <div>
      <MarkdownRenderer content={part.text} />
    </div>
  );
}
