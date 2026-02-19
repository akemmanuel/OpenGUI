import "katex/dist/katex.min.css";
import { memo } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { cn } from "@/lib/utils";
import { CodeBlock, CodeBlockCode } from "./ui/code-block";

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
		const code = String(children).replace(/\n$/, "");
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
			if (href && window.electronAPI?.openExternal) {
				e.preventDefault();
				window.electronAPI.openExternal(href);
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

const remarkPlugins = [remarkGfm, remarkMath];
const rehypePlugins = [[rehypeKatex, { strict: true }]] as Parameters<
	typeof ReactMarkdown
>[0]["rehypePlugins"];

export const MarkdownRenderer = memo(function MarkdownRenderer({
	content,
}: {
	content: string;
}) {
	// Escape exclamation marks inside math blocks so KaTeX doesn't choke on them
	const cleanedContent = content
		.replace(/(\$\$[^$]+\$\$|\$(?!\s)([^\n$]+?)(?<!\s)\$)/g, (match) =>
			match.replace(/!/g, "\\!"),
		)
		// Normalize " - " (em-dash pattern) to " - " in prose,
		// but skip fenced code blocks and inline code spans.
		.replace(
			/(```[\s\S]*?```|`[^`\n]+`)|( - )/g,
			(match, codeBlock: string | undefined) => (codeBlock ? match : " - "),
		);

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
