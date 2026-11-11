// Absolute paths may contain spaces in directory names (uploads land in
// `<Project>/.opengui-uploads/`, and Project folders like `Oliver Heindl` are
// common). The file name itself stays whitespace-free so a mention never
// swallows the prose that follows it. Other mentions end at whitespace.
const IMAGE_MENTION_PATTERN =
  /@((?:\/|[a-z]:[\\/]|\\\\)(?:[^\s\\/][^\\/\n]*[\\/])*?[^\s\\/]+\.(?:png|jpe?g|webp|gif)|[^\s]+\.(?:png|jpe?g|webp|gif))(?=\s|$)/gi;

function getImageMentionFilename(path: string): string {
  return path.split(/[\\/]/).pop() || "Image";
}

export type ImageMentionSegment =
  | { type: "text"; text: string }
  | { type: "image"; token: string; path: string; filename: string };

export function splitImageMentions(text: string): ImageMentionSegment[] {
  const segments: ImageMentionSegment[] = [];
  const pattern = new RegExp(IMAGE_MENTION_PATTERN.source, "gi");
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const token = match[0];
    const path = match[1];
    if (!path) continue;
    if (match.index > lastIndex) {
      segments.push({ type: "text", text: text.slice(lastIndex, match.index) });
    }
    segments.push({ type: "image", token, path, filename: getImageMentionFilename(path) });
    lastIndex = match.index + token.length;
  }

  if (lastIndex < text.length) segments.push({ type: "text", text: text.slice(lastIndex) });
  return segments.length > 0 ? segments : [{ type: "text", text }];
}
