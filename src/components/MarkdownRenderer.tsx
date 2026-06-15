import { common, createStarryNight } from "@wooorm/starry-night";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import onigurumaWasmUrl from "vscode-oniguruma/release/onig.wasm?url";
import { Check, Copy } from "lucide-react";
import {
  isValidElement,
  memo,
  type ComponentProps,
  type MouseEvent,
  useEffect,
  useMemo,
  useState,
} from "react";
import ReactMarkdown from "react-markdown";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import remarkGfm from "remark-gfm";
import { FilePathToken } from "@/components/FilePathToken";
import { Button } from "@/components/ui/button";
import { isFilePathLike } from "@/lib/file-paths";
import { cn, copyTextToClipboard, openExternalLink } from "@/lib/utils";

type StarryNight = Awaited<ReturnType<typeof createStarryNight>>;

let starryNightPromise: Promise<StarryNight> | null = null;

function getStarryNight() {
  starryNightPromise ??= createStarryNight(common, {
    getOnigurumaUrlFetch() {
      return new URL(onigurumaWasmUrl, window.location.href);
    },
  });
  return starryNightPromise;
}

function nodeToString(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeToString).join("");
  return "";
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

    getStarryNight()
      .then((starryNight) => {
        if (cancelled) return;
        const scope = starryNight.flagToScope(language);
        if (!scope) {
          setHighlighted(null);
          return;
        }
        const tree = starryNight.highlight(code, scope);
        setHighlighted(toJsxRuntime(tree, { Fragment, jsx, jsxs }));
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
        type="button"
        variant="outline"
        size="icon-sm"
        className="absolute top-2 right-2 z-10 bg-background/90 text-muted-foreground opacity-0 shadow-sm backdrop-blur transition-opacity focus:opacity-100 group-hover:opacity-100"
        onClick={handleCopy}
        aria-label={copied ? "Code copied" : "Copy code to clipboard"}
        title={copied ? "Copied" : "Copy"}
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </Button>
      <pre className="max-w-full overflow-x-auto rounded-lg border border-border/60 bg-muted/60 p-3">
        <code
          className={cn(
            "font-mono text-[var(--code-font-size)] leading-relaxed",
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

function createMarkdownComponents(baseDirectory?: string | null) {
  return {
    table({ children, node: _node, ...props }: ComponentProps<"table"> & { node?: unknown }) {
      return (
        <div className="markdown-table-scroll">
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
      if (href && isFilePathLike(href)) {
        return <FilePathToken path={href} baseDirectory={baseDirectory} />;
      }

      const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
        if (!href) return;
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
    code({ children, node: _node, ...props }: ComponentProps<"code"> & { node?: unknown }) {
      const value = nodeToString(children);
      if (!props.className && isFilePathLike(value)) {
        return <FilePathToken path={value} baseDirectory={baseDirectory} />;
      }

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
}

export const MarkdownRenderer = memo(function MarkdownRenderer({
  content,
  baseDirectory,
}: {
  content: string;
  baseDirectory?: string | null;
}) {
  const remarkPlugins = useMemo(() => [remarkGfm], []);
  const markdownComponents = useMemo(
    () => createMarkdownComponents(baseDirectory),
    [baseDirectory],
  );

  return (
    <div className="markdown-renderer text-sm leading-relaxed select-text">
      <ReactMarkdown components={markdownComponents} remarkPlugins={remarkPlugins} skipHtml>
        {content}
      </ReactMarkdown>
    </div>
  );
});
