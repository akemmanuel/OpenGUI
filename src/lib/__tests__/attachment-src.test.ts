import { describe, expect, test } from "bun:test";
import { resolveAttachmentImageSrc } from "../attachment-src";

describe("resolveAttachmentImageSrc", () => {
	test("keeps data urls unchanged", () => {
		const url = "data:image/png;base64,abc123";
		expect(resolveAttachmentImageSrc(url, "http://localhost:4096")).toBe(url);
	});

	test("resolves root-relative urls against server url", () => {
		expect(
			resolveAttachmentImageSrc(
				"/session/file/image.png",
				"http://localhost:4096/",
			),
		).toBe("http://localhost:4096/session/file/image.png");
	});

	test("resolves relative urls against server url", () => {
		expect(
			resolveAttachmentImageSrc(
				"session/file/image.png",
				"https://example.com/opencode",
			),
		).toBe("https://example.com/opencode/session/file/image.png");
	});

	test("keeps unix absolute paths as file urls when no server url exists", () => {
		expect(resolveAttachmentImageSrc("/tmp/image.png")).toBe(
			"file:///tmp/image.png",
		);
	});

	test("converts windows absolute paths to file urls", () => {
		expect(resolveAttachmentImageSrc("C:\\temp\\image.png")).toBe(
			"file:///C:/temp/image.png",
		);
	});
});
