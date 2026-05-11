const ZEN_CHAT_COMPLETIONS_URL = "https://opencode.ai/zen/v1/chat/completions";
const MODELS_DEV_URL = "https://models.dev/api.json";
const FALLBACK_TITLE_MODEL = "minimax-m2.5-free";
const FALLBACK_MAX_WORDS = 5;

type ModelsDevModel = {
  id?: string;
  name?: string;
  cost?: {
    input?: number;
    output?: number;
  };
  modalities?: {
    input?: string[];
    output?: string[];
  };
};

type ModelsDevProvider = {
  models?: Record<string, ModelsDevModel>;
};

function truncatePrompt(input: string): string {
  return input
    .split("\n")
    .map((paragraph) => paragraph.trim().slice(0, 350))
    .join("\n")
    .trim()
    .slice(0, 2000);
}

function titleCase(input: string): string {
  return input
    .toLowerCase()
    .replace(/\b\p{L}/gu, (letter) => letter.toUpperCase())
    .trim();
}

function cleanTitle(input: string): string {
  return input
    .replace(/^['"`]+|['"`]+$/g, "")
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function fallbackSessionTitle(prompt: string): string {
  if (
    /^\s*https?:\/\/(?:www\.)?(youtube\.com|youtu\.be)\//i.test(prompt) &&
    /\bsummarize\b/i.test(prompt)
  ) {
    return "YouTube Video Summary";
  }
  if (/^\s*https?:\/\//i.test(prompt) && /\bsummarize\b/i.test(prompt)) return "Link Summary";

  const text = truncatePrompt(prompt)
    .replace(/^https?:\/\/\S+\s*/i, "")
    .replace(
      /^\s*(summarize|generate|create|make|build|write|edit|fix|implement|add|help me|please)\b[:\s-]*/i,
      "",
    )
    .replace(/^\s*(an?|the|me|my)\b\s*/i, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const words = text.split(" ").filter(Boolean).slice(0, FALLBACK_MAX_WORDS);
  const title = cleanTitle(titleCase(words.join(" ")));
  return title || "New Session";
}

function extractChatCompletionText(data: unknown): string | null {
  const choices = (data as { choices?: unknown[] })?.choices;
  if (!Array.isArray(choices)) return null;
  const text = choices
    .map((choice) => (choice as { message?: { content?: unknown } })?.message?.content)
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n")
    .trim();
  return text || null;
}

function isBadGeneratedTitle(title: string): boolean {
  const normalized = title.toLowerCase();
  return (
    title.length > 80 ||
    /\b(we need|i need|i can|cannot access|can't access|unable to access|as an ai|output only|title generator)\b/i.test(
      normalized,
    )
  );
}

async function fetchFreeOpenCodeModels(): Promise<string[]> {
  const response = await fetch(MODELS_DEV_URL);
  if (!response.ok) return [FALLBACK_TITLE_MODEL];

  const data = (await response.json()) as { opencode?: ModelsDevProvider };
  const models = data.opencode?.models ?? {};
  const freeModels = Object.entries(models)
    .filter(([, model]) => {
      const input = model.modalities?.input ?? [];
      const output = model.modalities?.output ?? [];
      return (
        model.cost?.input === 0 &&
        model.cost?.output === 0 &&
        input.includes("text") &&
        output.includes("text")
      );
    })
    .map(([id]) => id)
    .sort((a, b) => {
      const rank = (id: string) => {
        if (id === FALLBACK_TITLE_MODEL) return 0;
        if (id.includes("minimax")) return 1;
        if (id.includes("hy3")) return 2;
        if (id.includes("glm")) return 3;
        if (id.includes("mimo")) return 4;
        return 5;
      };
      return rank(a) - rank(b) || a.localeCompare(b);
    });

  return freeModels.length > 0 ? freeModels : [FALLBACK_TITLE_MODEL];
}

const freeOpenCodeModelsPromise = fetchFreeOpenCodeModels().catch(() => [FALLBACK_TITLE_MODEL]);

export async function loadFreeOpenCodeTitleModels(): Promise<string[]> {
  return freeOpenCodeModelsPromise;
}

export async function generateSessionTitle(prompt: string): Promise<string> {
  const trimmedPrompt = truncatePrompt(prompt);
  if (!trimmedPrompt) return "New Session";

  const freeModels = await loadFreeOpenCodeTitleModels();
  const titlePrompt = `Generate a title for this conversation:\n\n${trimmedPrompt}`;

  for (const model of freeModels) {
    try {
      const response = await fetch(ZEN_CHAT_COMPLETIONS_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer public",
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: "system",
              content:
                "You are a title generator. Output ONLY one brief thread title. No reasoning. No explanations. Max 50 characters. Use same language as user. Never say you cannot access links.",
            },
            { role: "user", content: titlePrompt },
          ],
          temperature: 0.2,
          max_tokens: 1000,
          stream: false,
        }),
      });

      if (!response.ok) continue;
      const data = await response.json();
      const title = extractChatCompletionText(data);
      if (title) {
        const cleaned = cleanTitle(title);
        if (cleaned && !isBadGeneratedTitle(cleaned)) return cleaned;
      }
    } catch {
      continue;
    }
  }

  return fallbackSessionTitle(trimmedPrompt);
}
