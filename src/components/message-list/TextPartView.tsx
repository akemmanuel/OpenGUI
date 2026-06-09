import type { TextPart } from "@opencode-ai/sdk/v2/client";
import { ImageMentionPreview } from "@/components/ImageMentionPreview";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import { useConnectionState } from "@/hooks/use-agent-state";
import { splitImageMentions } from "@/lib/image-mentions";

export function TextPartView({ part, isUser }: { part: TextPart; isUser?: boolean }) {
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
            <ImageMentionPreview
              key={`${segment.path}-${index}`}
              token={segment.token}
              path={segment.path}
              filename={segment.filename}
              serverUrl={isLocalWorkspace ? null : workspaceServerUrl}
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
