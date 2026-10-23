import { Check, Copy } from "lucide-react";
import {
  createContext,
  isValidElement,
  memo,
  type ComponentProps,
  type MouseEvent,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import ReactMarkdown, { defaultUrlTransform, type UrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useTranslation } from "react-i18next";
import { HostImage } from "@/components/HostImage";
import type { ImageMention } from "@/components/ImageMentionPreview";
import { Button } from "@/components/ui/button";
import { classifyMarkdownImageSource, resolveAttachmentImageSrc } from "@/lib/attachment-src";
import { copyTextToClipboard, openExternalLink } from "@/lib/browser";
import { cn } from "@/lib/utils";

/**
 * Where markdown images may load from. Without a provider, images render as
 * their alt text only.
 */
export type MarkdownImageContextValue = {
  baseUrl: string | null;
  baseDirectory: string | null;
  onOpen?: (image: ImageMention) => void;
};

export const MarkdownImageContext = createContext<MarkdownImageContextValue | null>(null);

// The default transform drops `file:` and Windows drive paths (`C:` reads as a
// protocol). Image sources are validated by the `img` component instead.
const urlTransform: UrlTransform = (url, key, node) =>
  node.tagName === "img" && key === "src" ? url : defaultUrlTransform(url);

function imageFilename(path: string, alt: string | undefined) {
  return path.split(/[\\/]/).pop() || alt || "Image";
}

function MarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const { t } = useTranslation();
  const context = useContext(MarkdownImageContext);
  const source = context ? classifyMarkdownImageSource(src) : null;
  if (!context || !source) {
    // Model-authored markdown is untrusted. Do not automatically contact an
    // arbitrary image origin (tracking pixels can leak IP and URL metadata).
    return alt ? <span className="text-muted-foreground">{alt}</span> : null;
  }

  const path = source.kind === "path" ? source.path : source.src;
  const label = alt || (source.kind === "path" ? imageFilename(path, alt) : t("attachments.image"));
  const image: ImageMention = {
    path,
    filename: source.kind === "path" ? imageFilename(path, alt) : label,
  };
  const resolvedSrc = resolveAttachmentImageSrc(path, context.baseUrl, context.baseDirectory);

  return (
    <button
      type="button"
      className="my-2 block max-w-full overflow-hidden rounded-lg border border-border/60 bg-background/60 text-left focus:outline-none focus:ring-2 focus:ring-primary/40"
      title={source.kind === "path" ? path : label}
      aria-label={t("attachments.openImage", { name: label })}
      onClick={() => context.onOpen?.(image)}
    >
      <HostImage
        src={resolvedSrc}
        alt={label}
        loading="lazy"
        className="block max-h-80 max-w-full object-contain"
        fallbackClassName="m-1 h-8 min-w-40"
      />
    </button>
  );
}

function nodeToString(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeToString).join("");
  return "";
}

function isSafeExternalUrl(value: string): boolean {
  try {
    const url = new URL(value, window.location.href);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function guessCodeLanguage(code: string): string | null {
  const trimmed = code.trim();
  if (!trimmed) return null;

  if (/^\s*[{[]/.test(trimmed)) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {
      // Keep looking.
    }
  }

  if (/^\s*<[A-Z][\s\S]*>\s*$/i.test(trimmed)) return "html";
  if (/^\s*#include\s+<|\bint\s+main\s*\(/.test(trimmed)) return "c";
  if (/\bpackage\s+main\b|\bfunc\s+\w+\s*\(/.test(trimmed)) return "go";
  if (/\b(def|class)\s+\w+\s*\(|\bimport\s+[\w.]+|^\s*from\s+[\w.]+\s+import\b/m.test(trimmed)) {
    return "python";
  }
  if (/\b(fn|let|mut|impl|trait)\b|println!\s*\(/.test(trimmed)) return "rust";
  if (/\b(interface|type)\s+\w+\s*[={]|:\s*(string|number|boolean)\b/.test(trimmed)) return "ts";
  if (/\b(import|export)\b.*\bfrom\b|\b(const|let|var|function)\b|=>/.test(trimmed)) return "js";
  if (/^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER)\b/i.test(trimmed)) return "sql";
  if (/^\s*(apiVersion|kind|metadata):\s*$/m.test(trimmed)) return "yaml";
  if (/^\s*[\w.-]+:\s+.+$/m.test(trimmed) && !/[;{}]/.test(trimmed)) return "yaml";
  if (/^\s*(npm|pnpm|vp|git|cd|ls|cat|grep|rg|curl|sudo)\b/m.test(trimmed)) return "shell";

  return null;
}

function StarryCodeBlock({ children, className }: ComponentProps<"code">) {
  const { t } = useTranslation();
  const code = nodeToString(children).replace(/\n$/, "");
  const explicitLanguage = /language-([^\s]+)/.exec(className ?? "")?.[1];
  const language = explicitLanguage ?? guessCodeLanguage(code);
  const [highlighted, setHighlighted] = useState<React.ReactNode>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;

    if (!language) {
      setHighlighted(null);
      return;
    }

    import("@/lib/syntax-highlighter")
      .then(async ({ highlightCode }) => {
        if (cancelled) return;
        const highlightedCode = await highlightCode(code, language, window.location.href);
        if (!cancelled) setHighlighted(highlightedCode);
      })
      .catch(() => {
        if (!cancelled) setHighlighted(null);
      });

    return () => {
      cancelled = true;
    };
  }, [code, language]);

  useEffect(() => {
    if (!copied) return;

    const timeout = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  const handleCopy = async () => {
    await copyTextToClipboard(code);
    setCopied(true);
  };

  return (
    <div className="group relative my-3 max-w-full">
      <Button
        data-responsive-allow="hover-reveal"
        type="button"
        variant="outline"
        size="icon-sm"
        className="absolute top-2 right-2 z-10 bg-background/90 text-muted-foreground opacity-0 shadow-sm backdrop-blur transition-opacity focus:opacity-100 group-hover:opacity-100"
        onClick={handleCopy}
        aria-label={copied ? t("markdown.codeCopied") : t("markdown.copyCodeLabel")}
        title={copied ? t("markdown.copied") : t("markdown.copy")}
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </Button>
      <span className="sr-only" role="status" aria-live="polite">
        {copied ? t("markdown.codeCopied") : ""}
      </span>
      <pre
        data-responsive-allow="horizontal-scroll"
        className="max-w-full overflow-x-auto rounded-lg border border-border/60 bg-muted/60 p-3"
      >
        <code
          className={cn(
            "font-mono text-[13px] leading-relaxed",
            className,
            language && !explicitLanguage && `language-${language}`,
          )}
        >
          {highlighted ?? code}
        </code>
      </pre>
    </div>
  );
}

const markdownComponents = {
  table({ children, node: _node, ...props }: ComponentProps<"table"> & { node?: unknown }) {
    return (
      <div className="markdown-table-scroll" data-responsive-allow="horizontal-scroll">
        <table {...props}>{children}</table>
      </div>
    );
  },
  pre({ children }: ComponentProps<"pre">) {
    // react-markdown applies component mappings before passing children to `pre`,
    // so the child type is our mapped `code` function, not the literal "code" tag.
    // Treat any single React element child with code-like props as a fenced block.
    if (isValidElement<ComponentProps<"code">>(children)) {
      return (
        <StarryCodeBlock className={children.props.className}>
          {children.props.children}
        </StarryCodeBlock>
      );
    }

    return <pre>{children}</pre>;
  },
  a({ children, href, node: _node, ...props }: ComponentProps<"a"> & { node?: unknown }) {
    if (!href || !isSafeExternalUrl(href)) return <span>{children}</span>;
    const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      openExternalLink(href);
    };

    return (
      <a
        {...props}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary hover:underline"
        onClick={handleClick}
      >
        {children}
      </a>
    );
  },
  img({ src, alt }: ComponentProps<"img">) {
    return <MarkdownImage src={typeof src === "string" ? src : undefined} alt={alt} />;
  },
  code({ children, node: _node, ...props }: ComponentProps<"code"> & { node?: unknown }) {
    return (
      <code
        {...props}
        className="rounded bg-muted px-[0.3rem] py-[0.1rem] font-mono text-[0.85em] font-medium"
      >
        {children}
      </code>
    );
  },
};

export const MarkdownRenderer = memo(function MarkdownRenderer({ content }: { content: string }) {
  const remarkPlugins = useMemo(() => [remarkGfm], []);

  return (
    <div className="markdown-renderer text-sm leading-relaxed select-text">
      <ReactMarkdown
        components={markdownComponents}
        remarkPlugins={remarkPlugins}
        urlTransform={urlTransform}
        skipHtml
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
