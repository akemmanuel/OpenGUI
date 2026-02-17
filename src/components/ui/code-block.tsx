import { Check, Copy } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { codeToHtml } from "shiki";
import { cn } from "@/lib/utils";

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

			codeToHtml(code, {
				lang: language || "text",
				theme,
			})
				.then((result) => {
					if (!cancelled) setHtml(result);
				})
				.catch(() => {
					// Fallback: just show raw code
					if (!cancelled) setHtml(null);
				});
		}, 150);

		// Re-highlight when the theme changes
		const observer = new MutationObserver(() => {
			if (cancelled) return;
			const nowDark = document.documentElement.classList.contains("dark");
			const newTheme = nowDark ? "github-dark-default" : "github-light-default";
			codeToHtml(code, { lang: language || "text", theme: newTheme })
				.then((result) => {
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
		setTimeout(() => setCopied(false), 2000);
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
