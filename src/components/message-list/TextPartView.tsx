import { ImageMentionToken, type ImageMention } from "@/components/ImageMentionPreview";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import { useWorkspaceState } from "@/hooks/use-agent-state";
import { splitImageMentions } from "@/lib/image-mentions";
import type { TextTranscriptPart } from "@/protocol/session-transcript";

export function TextPartView({
  part,
  isUser,
  activeImagePath,
  onImageHover,
  onImageOpen,
  imageBaseDirectory,
}: {
  part: TextTranscriptPart;
  isUser?: boolean;
  activeImagePath?: string | null;
  onImageHover?: (path: string | null) => void;
  onImageOpen?: (image: ImageMention) => void;
  imageBaseDirectory?: string | null;
}) {
  const { attachmentBaseUrl } = useWorkspaceState();
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
              serverUrl={attachmentBaseUrl}
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
