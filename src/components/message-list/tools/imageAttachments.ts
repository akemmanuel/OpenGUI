import type { ToolPart } from "@opencode-ai/sdk/v2/client";
import { resolveAttachmentImageSrc } from "@/lib/attachment-src";

export interface ImageAttachmentInfo {
  url: string;
  src: string;
  mime: string;
  filename?: string;
}

export function extractImageAttachments(
  state: ToolPart["state"],
  serverUrl?: string | null,
  authToken?: string | null,
): ImageAttachmentInfo[] {
  if (state.status !== "completed") return [];
  if (!Array.isArray(state.attachments) || state.attachments.length === 0) return [];

  return state.attachments
    .filter((att) => {
      const mime = (att.mime ?? "").toLowerCase();
      return mime === "image/png" || mime === "image/jpeg" || mime === "image/jpg";
    })
    .map((att) => ({
      url: att.url,
      src: resolveAttachmentImageSrc(att.url, serverUrl, null, authToken),
      mime: att.mime,
      filename: att.filename,
    }));
}
