import type { TranscriptRow } from "@/features/session-transcript/transcript-row-model";
import { splitImageMentions } from "@/lib/image-mentions";

const PREVIEW_MAX_CHARS = 280;

export type PromptMarker = {
  /** Message id of the user prompt; matches the row's `data-message-id`. */
  id: string;
  prompt: string;
  reply: string;
};

function visibleText(row: TranscriptRow): string {
  const text = row.entry.parts
    .map((part) => (part.type === "text" && !part.synthetic && !part.ignored ? part.text : ""))
    .join(" ");
  return splitImageMentions(text)
    .map((segment) => (segment.type === "text" ? segment.text : segment.filename))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

function clip(text: string): string {
  return text.length > PREVIEW_MAX_CHARS ? `${text.slice(0, PREVIEW_MAX_CHARS - 1)}…` : text;
}

/** One marker per user prompt, paired with the text of the reply that followed it. */
export function buildPromptMarkers(rows: readonly TranscriptRow[]): PromptMarker[] {
  const markers: PromptMarker[] = [];
  let replyParts: string[] = [];

  const closeReply = () => {
    const current = markers.at(-1);
    if (current) current.reply = clip(replyParts.join(" ").trim());
    replyParts = [];
  };

  for (const row of rows) {
    if (row.entry.info.role === "user") {
      closeReply();
      markers.push({ id: row.id, prompt: clip(visibleText(row)), reply: "" });
    } else if (markers.length > 0 && replyParts.join(" ").length < PREVIEW_MAX_CHARS) {
      const text = visibleText(row);
      if (text) replyParts.push(text);
    }
  }
  closeReply();
  return markers;
}
