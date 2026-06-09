import type { TextPart } from "@opencode-ai/sdk/v2/client";
import { ImageMentionToken, type ImageMention } from "@/components/ImageMentionPreview";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import { useConnectionState } from "@/hooks/use-agent-state";
import { splitImageMentions } from "@/lib/image-mentions";

export function TextPartView({
  part,
  isUser,
  activeImagePath,
  onImageHover,
  onImageOpen,
  imageBaseDirectory,
}: {
  part: TextPart;
  isUser?: boolean;
  activeImagePath?: string | null;
  onImageHover?: (path: string | null) => void;
  onImageOpen?: (image: ImageMention) => void;
  imageBaseDirectory?: string | null;
}) {
  const { isLocalWorkspace, workspaceServerUrl } = useConnectionState();
  if (!part.text) return null;

  if (isUser) {
    const segments = splitImageMentions(part.text);
    return (
      <div className="text-sm whitespace-pre-wrap break-words select-text">
        {segments.map((segment, index) =>
          segment.type === "text" ? (
            segment.text
          ) : (
            <ImageMentionToken
              key={`${segment.path}-${index}`}
              token={segment.token}
              image={{ path: segment.path, filename: segment.filename }}
              serverUrl={isLocalWorkspace ? null : workspaceServerUrl}
              baseDirectory={imageBaseDirectory}
              active={activeImagePath === segment.path}
              onHover={onImageHover}
              onOpen={onImageOpen}
            />
          ),
        )}
      </div>
    );
  }

  return (
    <div>
      <MarkdownRenderer content={part.text} />
    </div>
  );
}
