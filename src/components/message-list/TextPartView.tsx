import type { TextPart } from "@opencode-ai/sdk/v2/client";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";

export function TextPartView({ part, isUser }: { part: TextPart; isUser?: boolean }) {
  if (!part.text) return null;

  if (isUser) {
    return <div className="text-sm whitespace-pre-wrap break-words select-text">{part.text}</div>;
  }

  return (
    <div>
      <MarkdownRenderer content={part.text} />
    </div>
  );
}
