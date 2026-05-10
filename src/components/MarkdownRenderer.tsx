import { memo, type ComponentProps, type MouseEvent } from "react";
import { Streamdown } from "streamdown";
import "streamdown/styles.css";
import { openExternalLink } from "@/lib/utils";

const markdownComponents = {
  a({ children, href, node: _node, ...props }: ComponentProps<"a"> & { node?: unknown }) {
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
  inlineCode({ children, node: _node, ...props }: ComponentProps<"code"> & { node?: unknown }) {
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
  return (
    <Streamdown
      className="markdown-renderer text-sm leading-relaxed select-text"
      components={markdownComponents}
      controls={false}
      lineNumbers={false}
      linkSafety={{ enabled: false }}
      remend={{ katex: false }}
      skipHtml
    >
      {content}
    </Streamdown>
  );
});
