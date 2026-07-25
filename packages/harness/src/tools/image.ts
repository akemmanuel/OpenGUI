import { readFile } from "node:fs/promises";
import * as photon from "@silvia-odwyer/photon-node";

const MAX_DIMENSION = 2_000;
const MAX_BASE64_BYTES = 4.5 * 1024 * 1024;
const JPEG_QUALITIES = [80, 70, 55, 40];

export interface ModelImageAttachment {
  type: "image";
  data: string;
  mimeType: string;
}

export interface ProcessedImage extends ModelImageAttachment {
  note?: string;
}

function startsWith(bytes: Uint8Array, signature: readonly number[]) {
  return signature.every((byte, index) => bytes[index] === byte);
}

export function detectImageMimeType(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (Buffer.from(bytes.subarray(0, 3)).toString("ascii") === "GIF") return "image/gif";
  if (
    Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" &&
    Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP"
  )
    return "image/webp";
  if (Buffer.from(bytes.subarray(0, 2)).toString("ascii") === "BM") return "image/bmp";
  return null;
}

function encoded(bytes: Uint8Array, mimeType: string) {
  const data = Buffer.from(bytes).toString("base64");
  return { type: "image" as const, data, mimeType, size: Buffer.byteLength(data) };
}

/** Pi-style image normalization: cap dimensions and keep the base64 payload below provider limits. */
export async function processImageFile(path: string): Promise<ProcessedImage | null> {
  const bytes = await readFile(path);
  const detectedMimeType = detectImageMimeType(bytes);
  if (!detectedMimeType) return null;

  let source: photon.PhotonImage | undefined;
  try {
    source = photon.PhotonImage.new_from_byteslice(bytes);
    const originalWidth = source.get_width();
    const originalHeight = source.get_height();
    const original = encoded(bytes, detectedMimeType);
    if (
      originalWidth <= MAX_DIMENSION &&
      originalHeight <= MAX_DIMENSION &&
      original.size < MAX_BASE64_BYTES &&
      detectedMimeType !== "image/bmp"
    ) {
      return original;
    }

    const scale = Math.min(1, MAX_DIMENSION / originalWidth, MAX_DIMENSION / originalHeight);
    let width = Math.max(1, Math.round(originalWidth * scale));
    let height = Math.max(1, Math.round(originalHeight * scale));

    while (true) {
      const resized = photon.resize(source, width, height, photon.SamplingFilter.Lanczos3);
      try {
        const candidates = [
          encoded(resized.get_bytes(), "image/png"),
          ...JPEG_QUALITIES.map((quality) =>
            encoded(resized.get_bytes_jpeg(quality), "image/jpeg"),
          ),
        ].sort((left, right) => left.size - right.size);
        const candidate = candidates.find((item) => item.size < MAX_BASE64_BYTES);
        if (candidate) {
          return {
            ...candidate,
            note: `[Image: original ${originalWidth}x${originalHeight}, displayed at ${width}x${height}.]`,
          };
        }
      } finally {
        resized.free();
      }

      if (width === 1 && height === 1) return null;
      width = width === 1 ? 1 : Math.max(1, Math.floor(width * 0.75));
      height = height === 1 ? 1 : Math.max(1, Math.floor(height * 0.75));
    }
  } catch {
    return null;
  } finally {
    source?.free();
  }
}
