import * as React from "react";
import {
  ImageMentionLightbox,
  ImageMentionThumbnails,
  type ImageMention,
} from "@/components/ImageMentionPreview";
import { splitImageMentions } from "@/lib/image-mentions";

export function usePromptImages(value: string) {
  return React.useMemo(() => {
    const seen = new Set<string>();
    const images: ImageMention[] = [];
    for (const segment of splitImageMentions(value)) {
      if (segment.type !== "image" || seen.has(segment.path)) continue;
      seen.add(segment.path);
      images.push({ path: segment.path, filename: segment.filename });
    }
    return images;
  }, [value]);
}

export function PromptImageMentions({
  images,
  serverUrl,
  baseDirectory,
}: {
  images: ImageMention[];
  serverUrl: string | null | undefined;
  baseDirectory: string | null;
}) {
  const [activeImagePath, setActiveImagePath] = React.useState<string | null>(null);
  const [openImage, setOpenImage] = React.useState<ImageMention | null>(null);

  return (
    <>
      {images.length > 0 && (
        <ImageMentionThumbnails
          images={images}
          serverUrl={serverUrl}
          baseDirectory={baseDirectory}
          activePath={activeImagePath}
          onHover={setActiveImagePath}
          onOpen={setOpenImage}
          className="px-3 pt-2"
        />
      )}
      <ImageMentionLightbox
        image={openImage}
        serverUrl={serverUrl}
        baseDirectory={baseDirectory}
        onClose={() => setOpenImage(null)}
      />
    </>
  );
}
