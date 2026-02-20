import { createHighlighterCore } from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import { Check, Copy } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { bundledLanguages } from "shiki/langs";
import { COPY_FEEDBACK_MS, HIGHLIGHT_DEBOUNCE_MS } from "@/lib/constants";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Singleton shiki highlighter (JS engine -- no WASM needed)
// ---------------------------------------------------------------------------

type Highlighter = Awaited<ReturnType<typeof createHighlighterCore>>;

let _highlighter: Highlighter | null = null;
let _highlighterPromise: Promise<Highlighter> | null = null;

function getHighlighter(): Promise<Highlighter> {
	if (_highlighter) return Promise.resolve(_highlighter);
	if (_highlighterPromise) return _highlighterPromise;

	_highlighterPromise = createHighlighterCore({
		themes: [
			import("@shikijs/themes/github-dark-default"),
			import("@shikijs/themes/github-light-default"),
		],
		langs: [],
		engine: createJavaScriptRegexEngine(),
	}).then((h) => {
		_highlighter = h;
		return h;
	});

	return _highlighterPromise;
}

async function highlight(
	code: string,
	language: string,
	theme: string,
): Promise<string> {
	const highlighter = await getHighlighter();

	// Load the language on demand if not already loaded
	const lang = language || "text";
	if (
		lang !== "text" &&
		!highlighter.getLoadedLanguages().includes(lang) &&
		bundledLanguages[lang as keyof typeof bundledLanguages]
	) {
		await highlighter.loadLanguage(
			bundledLanguages[lang as keyof typeof bundledLanguages],
		);
	}

	const effectiveLang = highlighter.getLoadedLanguages().includes(lang)
		? lang
		: "text";

	return highlighter.codeToHtml(code, { lang: effectiveLang, theme });
}

// ---------------------------------------------------------------------------
// CodeBlock wrapper
// ---------------------------------------------------------------------------

export function CodeBlock({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<div
			className={cn(
				"group relative my-3 overflow-hidden rounded-lg border bg-muted/50",
				className,
			)}
		>
			{children}
		</div>
	);
}

// ---------------------------------------------------------------------------
// CodeBlockCode - syntax-highlighted via shiki
// ---------------------------------------------------------------------------

export function CodeBlockCode({
	code,
	language,
}: {
	code: string;
	language: string;
}) {
	const [html, setHtml] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);

	useEffect(() => {
		let cancelled = false;

		// Debounce highlighting to avoid hammering shiki during streaming
		const timer = setTimeout(() => {
			const isDark = document.documentElement.classList.contains("dark");
			const theme = isDark ? "github-dark-default" : "github-light-default";

			highlight(code, language, theme)
				.then((result: string) => {
					if (!cancelled) setHtml(result);
				})
				.catch((err: unknown) => {
					console.warn("[shiki] Highlighting failed:", err);
					if (!cancelled) setHtml(null);
				});
		}, HIGHLIGHT_DEBOUNCE_MS);

		// Re-highlight when the theme changes
		const observer = new MutationObserver(() => {
			if (cancelled) return;
			const nowDark = document.documentElement.classList.contains("dark");
			const newTheme = nowDark ? "github-dark-default" : "github-light-default";
			highlight(code, language, newTheme)
				.then((result: string) => {
					if (!cancelled) setHtml(result);
				})
				.catch(() => {});
		});
		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["class"],
		});

		return () => {
			cancelled = true;
			clearTimeout(timer);
			observer.disconnect();
		};
	}, [code, language]);

	const handleCopy = () => {
		navigator.clipboard.writeText(code).catch(() => {
			// Clipboard API may fail silently in some contexts
		});
		setCopied(true);
		setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
	};

	return (
		<>
			{/* Header bar with language + copy button */}
			<div className="flex items-center justify-between border-b bg-muted/80 px-3 py-1.5 text-xs text-muted-foreground">
				<span>{language || "text"}</span>
				<button
					type="button"
					onClick={handleCopy}
					className="flex items-center gap-1 hover:text-foreground transition-colors"
				>
					{copied ? (
						<>
							<Check className="size-3" />
							Copied
						</>
					) : (
						<>
							<Copy className="size-3" />
							Copy
						</>
					)}
				</button>
			</div>

			{/* Code content */}
			{html ? (
				<div
					className="overflow-x-auto p-3 text-sm [&>pre]:!bg-transparent [&>pre]:!p-0 [&>pre]:!m-0"
					// biome-ignore lint/security/noDangerouslySetInnerHtml: pre-sanitized syntax-highlighted HTML from shiki
					dangerouslySetInnerHTML={{ __html: html }}
				/>
			) : (
				<pre className="overflow-x-auto p-3 text-sm bg-transparent">
					<code>{code}</code>
				</pre>
			)}
		</>
	);
}
