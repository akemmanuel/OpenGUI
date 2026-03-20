import katexStylesheetHref from "katex/dist/katex.min.css" with {
	type: "file",
};
import { memo, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn, openExternalLink } from "@/lib/utils";
import { CodeBlock, CodeBlockCode } from "./ui/code-block";

type MarkdownPlugin = NonNullable<
	Parameters<typeof ReactMarkdown>[0]["remarkPlugins"]
>[number];
type HtmlPlugin = NonNullable<
	Parameters<typeof ReactMarkdown>[0]["rehypePlugins"]
>[number];

let mathPluginsPromise: Promise<{
	remarkMath: MarkdownPlugin;
	rehypeKatex: HtmlPlugin;
}> | null = null;
let katexStylesheetLoaded = false;
const katexStylesheetUrl = katexStylesheetHref as unknown as string;

function hasMathContent(content: string): boolean {
	return /(^|[^\\])\$\$(?:[\s\S]+?)\$\$|(^|[^\\])\$(?!\s)(?:[^\n$]|\\\$)+(?<!\s)\$|\\\\\(|\\\\\[/.test(
		content,
	);
}

async function loadMathPlugins() {
	if (!mathPluginsPromise) {
		mathPluginsPromise = Promise.all([
			import("remark-math"),
			import("rehype-katex"),
		]).then(([remarkMathModule, rehypeKatexModule]) => ({
			remarkMath: remarkMathModule.default,
			rehypeKatex: [rehypeKatexModule.default, { strict: true }] as HtmlPlugin,
		}));
	}

	return mathPluginsPromise;
}

function ensureKatexStylesheet() {
	if (katexStylesheetLoaded || typeof document === "undefined") return;
	if (
		document.head.querySelector(
			`link[data-katex-stylesheet="true"][href="${katexStylesheetUrl}"]`,
		)
	) {
		katexStylesheetLoaded = true;
		return;
	}

	const link = document.createElement("link");
	link.rel = "stylesheet";
	link.href = katexStylesheetUrl;
	link.dataset.katexStylesheet = "true";
	document.head.append(link);
	katexStylesheetLoaded = true;
}

// Stable components object - defined at module scope to avoid recreating on
// every render, which would cause react-markdown to remount the entire tree
// (destroying CodeBlockCode state and losing cached shiki HTML).
const markdownComponents = {
	code({
		className,
		children,
		...props
	}: {
		className?: string;
		children?: React.ReactNode;
		[key: string]: unknown;
	}) {
		const match = /language-(\w+)/.exec(className || "");
		const language = match ? match[1] : "";
		const code = (typeof children === "string" ? children : "").replace(
			/\n$/,
			"",
		);
		const isBlock = !!language;

		if (isBlock) {
			return (
				<CodeBlock>
					<CodeBlockCode code={code} language={language} />
				</CodeBlock>
			);
		}

		return (
			<code
				className={cn(
					"rounded bg-muted px-[0.3rem] py-[0.1rem] font-mono text-[0.85em] font-medium",
					className,
				)}
				{...props}
			>
				{children}
			</code>
		);
	},
	pre({ children }: { children?: React.ReactNode }) {
		return <>{children}</>;
	},
	table({ children }: { children?: React.ReactNode }) {
		return (
			<div className="overflow-x-auto my-4 rounded-lg border border-border">
				<table className="w-full border-collapse text-sm">{children}</table>
			</div>
		);
	},
	thead({ children }: { children?: React.ReactNode }) {
		return (
			<thead className="bg-muted/50 border-b border-border">{children}</thead>
		);
	},
	th({
		children,
		...props
	}: {
		children?: React.ReactNode;
		[key: string]: unknown;
	}) {
		return (
			<th
				className="px-3 py-2 text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider"
				{...props}
			>
				{children}
			</th>
		);
	},
	td({
		children,
		...props
	}: {
		children?: React.ReactNode;
		[key: string]: unknown;
	}) {
		return (
			<td className="px-3 py-2 text-sm border-t border-border" {...props}>
				{children}
			</td>
		);
	},
	a({
		children,
		href,
		...props
	}: {
		children?: React.ReactNode;
		href?: string;
		[key: string]: unknown;
	}) {
		const handleClick = (e: React.MouseEvent) => {
			if (href) {
				e.preventDefault();
				openExternalLink(href);
			}
		};
		return (
			<a
				href={href}
				target="_blank"
				rel="noopener noreferrer"
				className="text-primary hover:underline"
				onClick={handleClick}
				{...props}
			>
				{children}
			</a>
		);
	},
};

export const MarkdownRenderer = memo(function MarkdownRenderer({
	content,
}: {
	content: string;
}) {
	const needsMath = hasMathContent(content);
	const [mathPlugins, setMathPlugins] = useState<{
		remarkMath: MarkdownPlugin;
		rehypeKatex: HtmlPlugin;
	} | null>(null);

	useEffect(() => {
		if (!needsMath) return;

		let cancelled = false;
		ensureKatexStylesheet();
		loadMathPlugins()
			.then((plugins) => {
				if (!cancelled) setMathPlugins(plugins);
			})
			.catch((error: unknown) => {
				console.warn("[markdown] Failed to load math rendering:", error);
			});

		return () => {
			cancelled = true;
		};
	}, [needsMath]);

	// Escape dollar signs used as currency ($ followed by a digit) so
	// remark-math doesn't treat them as LaTeX math delimiters.
	// Then escape exclamation marks inside math blocks so KaTeX doesn't choke on them.
	const cleanedContent = content
		.replace(/\$(?=\d)/g, "\\$")
		.replace(/(\$\$[^$]+\$\$|\$(?!\s)([^\n$]+?)(?<!\s)\$)/g, (match) =>
			match.replace(/!/g, "\\!"),
		)
		// Normalize " - " (em-dash pattern) to " - " in prose,
		// but skip fenced code blocks and inline code spans.
		.replace(
			/(```[\s\S]*?```|`[^`\n]+`)|( - )/g,
			(match, codeBlock: string | undefined) => (codeBlock ? match : " - "),
		);

	const remarkPlugins = mathPlugins
		? [remarkGfm, mathPlugins.remarkMath]
		: [remarkGfm];
	const rehypePlugins = mathPlugins ? [mathPlugins.rehypeKatex] : undefined;

	return (
		<div className="markdown-renderer prose dark:prose-invert prose-sm max-w-none overflow-hidden break-words select-text text-sm leading-relaxed">
			<ReactMarkdown
				remarkPlugins={remarkPlugins}
				rehypePlugins={rehypePlugins}
				components={markdownComponents as Record<string, React.ComponentType>}
			>
				{cleanedContent}
			</ReactMarkdown>
		</div>
	);
});
