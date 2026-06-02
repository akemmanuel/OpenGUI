import * as React from "react";
import { compressImage } from "@/lib/image-compression";

export function getImageFiles(files: FileList | File[]): File[] {
  return Array.from(files).filter((file) => file.type.startsWith("image/"));
}

export function usePromptImages({
  disabled,
  setImagePreviews,
}: {
  disabled: boolean;
  setImagePreviews: React.Dispatch<React.SetStateAction<string[]>>;
}) {
  const [isDragging, setIsDragging] = React.useState(false);

  const appendImages = React.useCallback(
    async (files: FileList | File[]) => {
      if (disabled) return;
      const imageFiles = getImageFiles(files);
      if (imageFiles.length === 0) return;
      const results = await Promise.all(imageFiles.map(compressImage));
      setImagePreviews((previous) => [...previous, ...results]);
    },
    [disabled, setImagePreviews],
  );

  const handleFileChange = React.useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      if (disabled) return;
      if (event.target.files) {
        void appendImages(event.target.files);
      }
      event.target.value = "";
    },
    [appendImages, disabled],
  );

  const removeImage = React.useCallback(
    (index: number, event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      setImagePreviews((previous) => previous.filter((_, itemIndex) => itemIndex !== index));
    },
    [setImagePreviews],
  );

  const handleDragOver = React.useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (disabled) return;
      setIsDragging(true);
    },
    [disabled],
  );

  const handleDragLeave = React.useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = React.useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (disabled) return;
      setIsDragging(false);
      if (event.dataTransfer.files.length > 0) {
        void appendImages(event.dataTransfer.files);
      }
    },
    [appendImages, disabled],
  );

  const handlePaste = React.useCallback(
    (event: React.ClipboardEvent) => {
      if (disabled) return;
      const imageFiles: File[] = [];
      for (const item of Array.from(event.clipboardData.items)) {
        if (!item.type.startsWith("image/")) continue;
        const file = item.getAsFile();
        if (file) imageFiles.push(file);
      }
      if (imageFiles.length > 0) {
        void appendImages(imageFiles);
      }
    },
    [appendImages, disabled],
  );

  return {
    isDragging,
    appendImages,
    handleFileChange,
    removeImage,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    handlePaste,
  };
}
