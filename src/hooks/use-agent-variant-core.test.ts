import { describe, expect, test } from "bun:test";
import type { Model } from "@opencode-ai/sdk/v2/client";
import {
	cycleVariantSelection,
	normalizeVariantSelection,
	previousVariantSelection,
	updateVariantSelections,
} from "./use-agent-variant-core";

const model = {
	variants: {
		low: { label: "Low" },
		medium: { label: "Medium" },
		high: { label: "High" },
	},
} as unknown as Model;

describe("normalizeVariantSelection", () => {
	test("maps undefined to first available variant", () => {
		expect(normalizeVariantSelection(undefined, model)).toBe("low");
	});
});

describe("previousVariantSelection", () => {
	test("steps backward through variants", () => {
		expect(previousVariantSelection("high", model)).toBe("medium");
		expect(previousVariantSelection("medium", model)).toBe("low");
	});

	test("wraps from first variant to last", () => {
		expect(previousVariantSelection("low", model)).toBe("high");
	});

	test("wraps undefined to last variant", () => {
		expect(previousVariantSelection(undefined, model)).toBe("high");
	});
});

describe("cycleVariantSelection", () => {
	test("cycles forward through variants and wraps to first", () => {
		expect(cycleVariantSelection(undefined, model)).toBe("low");
		expect(cycleVariantSelection("low", model)).toBe("medium");
		expect(cycleVariantSelection("medium", model)).toBe("high");
		expect(cycleVariantSelection("high", model)).toBe("low");
	});

	test("stores explicit wrapped variant selection", () => {
		const key = "provider/model";
		const selections = updateVariantSelections({ [key]: "high" }, key, cycleVariantSelection("high", model));
		expect(selections[key]).toBe("low");
	});
});
