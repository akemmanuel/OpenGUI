import { describe, expect, test } from "bun:test";
import type { Provider } from "@opencode-ai/sdk/v2/client";
import { abbreviatePath, findModel } from "../utils";

describe("abbreviatePath", () => {
	test("replaces home directory with ~", () => {
		expect(abbreviatePath("/home/user/projects/foo", "/home/user")).toBe(
			"~/projects/foo",
		);
	});

	test("returns original path when homeDir is empty", () => {
		expect(abbreviatePath("/home/user/projects/foo", "")).toBe(
			"/home/user/projects/foo",
		);
	});

	test("returns original path when it does not start with homeDir", () => {
		expect(abbreviatePath("/var/lib/data", "/home/user")).toBe("/var/lib/data");
	});

	test("handles exact homeDir match", () => {
		expect(abbreviatePath("/home/user", "/home/user")).toBe("~");
	});
});

describe("findModel", () => {
	const mockProviders = [
		{
			id: "openai",
			name: "OpenAI",
			models: {
				"gpt-4": { name: "GPT-4", id: "gpt-4" },
			},
		},
		{
			id: "anthropic",
			name: "Anthropic",
			models: {
				"claude-3": { name: "Claude 3", id: "claude-3" },
			},
		},
	] as unknown as Provider[];

	test("finds a model by provider and model ID", () => {
		const model = findModel(mockProviders, "openai", "gpt-4");
		expect(model).toBeDefined();
		expect(model?.name).toBe("GPT-4");
	});

	test("returns undefined for unknown provider", () => {
		expect(findModel(mockProviders, "unknown", "gpt-4")).toBeUndefined();
	});

	test("returns undefined for unknown model", () => {
		expect(findModel(mockProviders, "openai", "gpt-5")).toBeUndefined();
	});

	test("returns undefined for empty providers list", () => {
		expect(findModel([], "openai", "gpt-4")).toBeUndefined();
	});
});
