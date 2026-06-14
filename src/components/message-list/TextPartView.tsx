import type { TextPart } from "@opencode-ai/sdk/v2/client";
import { ImageMentionToken, type ImageMention } from "@/components/ImageMentionPreview";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import { splitImageMentions } from "@/lib/image-mentions";

export function TextPartView({
  part,
  isUser,
  activeImagePath,
  onImageHover,
  onImageOpen,
  imageBaseDirectory,
  imageServerUrl,
  imageAuthToken,
}: {
  part: TextPart;
  isUser?: boolean;
  activeImagePath?: string | null;
  onImageHover?: (path: string | null) => void;
  onImageOpen?: (image: ImageMention) => void;
  imageBaseDirectory?: string | null;
  imageServerUrl?: string | null;
  imageAuthToken?: string | null;
}) {
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
              serverUrl={imageServerUrl}
              baseDirectory={imageBaseDirectory}
              authToken={imageAuthToken}
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
