const TARGET_IMAGE_SIZE = 4.5 * 1024 * 1024;
const MAX_DIMENSION = 4096;

export async function compressImage(file: File): Promise<string> {
  const dataUrl = await readFileAsDataURL(file);
  if (file.size <= TARGET_IMAGE_SIZE) return dataUrl;

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      let width = img.width;
      let height = img.height;

      if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
        const ratio = Math.min(MAX_DIMENSION / width, MAX_DIMENSION / height);
        width = Math.round(width * ratio);
        height = Math.round(height * ratio);
      }

      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("Failed to get canvas context"));
        return;
      }
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);

      let quality = 0.9;
      const tryCompress = () => {
        const result = canvas.toDataURL("image/jpeg", quality);
        const base64Length = result.length - "data:image/jpeg;base64,".length;
        const byteSize = Math.round((base64Length * 3) / 4);

        if (byteSize <= TARGET_IMAGE_SIZE) {
          resolve(result);
        } else if (quality > 0.1) {
          quality -= 0.1;
          tryCompress();
        } else {
          console.warn(
            `Image still exceeds target size (${byteSize} bytes) even at minimum quality. Returning low-quality result.`,
          );
          resolve(result);
        }
      };
      tryCompress();
      img.src = "";
    };
    img.onerror = () => {
      reject(new Error("Failed to load image. The file may be corrupt."));
    };
    img.src = dataUrl;
  });
}

function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
