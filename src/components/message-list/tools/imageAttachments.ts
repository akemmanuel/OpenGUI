import { resolveAttachmentImageSrc } from "@/lib/attachment-src";
import type { ToolCallState } from "@/protocol/session-transcript";

export interface ImageAttachmentInfo {
  url: string;
  src: string;
  mime: string;
  filename?: string;
}

export function extractImageAttachments(
  state: ToolCallState,
  serverUrl?: string | null,
): ImageAttachmentInfo[] {
  if (state.status !== "completed") return [];
  if (!Array.isArray(state.attachments) || state.attachments.length === 0) return [];

  return state.attachments
    .filter((att) => {
      const mime = (att.mime ?? "").toLowerCase();
      return mime === "image/png" || mime === "image/jpeg" || mime === "image/jpg";
    })
    .map((att) => {
      const mime = att.mime ?? "";
      return {
        url: att.url,
        src: resolveAttachmentImageSrc(att.url, serverUrl),
        mime,
        filename: att.filename,
      };
    });
}
