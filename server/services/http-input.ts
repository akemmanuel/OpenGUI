import type { QueueMode, SelectedModel } from "@opengui/protocol";
import type { QuestionAnswer } from "@opencode-ai/sdk/v2/client";

export async function readJsonBody(request: Request) {
  try {
    return await request.json();
  } catch {
    throw new Error("Invalid JSON body");
  }
}

export function toOptionalString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${fieldName} must be a string`);
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function toOptionalNullableString(
  value: unknown,
  fieldName: string,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`${fieldName} must be a string or null`);
  const trimmed = value.trim();
  return trimmed || null;
}

export function toOptionalSelectedModel(value: unknown): SelectedModel | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as unknown as SelectedModel)
    : undefined;
}

export function toQueueMode(value: unknown, fallback: QueueMode): QueueMode;
export function toQueueMode(value: unknown, fallback?: QueueMode): QueueMode | undefined;
export function toQueueMode(value: unknown, fallback?: QueueMode): QueueMode | undefined {
  const mode = toOptionalString(value, "mode");
  if (mode !== "queue" && mode !== "interrupt" && mode !== "after-part") return fallback;
  return mode;
}

export function toQuestionAnswers(value: unknown): QuestionAnswer[] {
  if (!Array.isArray(value)) return [];
  return value.map((answer, answerIndex) => {
    if (!Array.isArray(answer)) {
      throw new Error(`answers[${answerIndex}] must be an array`);
    }
    return answer.map((item, itemIndex) => {
      if (typeof item !== "string") {
        throw new Error(`answers[${answerIndex}][${itemIndex}] must be a string`);
      }
      return item.trim();
    });
  });
}
