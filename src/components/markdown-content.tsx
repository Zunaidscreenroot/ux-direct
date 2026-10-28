import * as React from "react";
import { Fragment, type ReactNode } from "react";

function renderInlineMarkdown(value: string): ReactNode[] {
  const tokens = value.split(/(\[[^\]]+\]\(https?:\/\/[^\s)]+\)|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\x60[^\x60\n]+\x60|\*[^*\n]+?\*|_[^_\n]+?_)/g);
  return tokens.filter((token) => token.length > 0).map((token, index) => {
    const key = "inline-" + index;
    if (token.startsWith("**") && token.endsWith("**") || token.startsWith("__") && token.endsWith("__")) {
      return <strong key={key}>{token.slice(2, -2)}</strong>;
    }
    if (token.startsWith("~~") && token.endsWith("~~")) return <del key={key}>{token.slice(2, -2)}</del>;
    if (token.charAt(0) === "\x60" && token.charAt(token.length - 1) === "\x60") {
      return <code key={key}>{token.slice(1, -1)}</code>;
    }
    if ((token.startsWith("*") && token.endsWith("*") && !token.startsWith("**")) ||
        (token.startsWith("_") && token.endsWith("_") && !token.startsWith("__"))) {
      return <em key={key}>{token.slice(1, -1)}</em>;
    }
    if (token.startsWith("[") && token.includes("](") && token.endsWith(")")) {
      const splitAt = token.indexOf("](");
      const label = token.slice(1, splitAt);
      const url = token.slice(splitAt + 2, -1);
      if (/^https?:\/\//i.test(url)) {
        return <a key={key} href={url} target="_blank" rel="noopener noreferrer">{label}</a>;
      }
    }
    return <Fragment key={key}>{token}</Fragment>;
  });
}

function renderInlineLines(lines: string[]): ReactNode[] {
  return lines.flatMap((line, index) => [
    <Fragment key={"line-" + index}>{renderInlineMarkdown(line)}</Fragment>,
    ...(index < lines.length - 1 ? [<br key={"break-" + index} />] : []),
  ]);
}

/** Small, dependency-free Markdown renderer for streamed assistant answers. */
export function MarkdownContent({ content }: { content: string }) {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let listItems: string[] = [];
  let listKind: "ul" | "ol" | null = null;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push(<p key={"p-" + blocks.length}>{renderInlineLines(paragraph)}</p>);
    paragraph = [];
  };
  const flushList = () => {
    if (!listItems.length || !listKind) return;
    const items = listItems.map((item, index) => <li key={"li-" + index}>{renderInlineMarkdown(item)}</li>);
    blocks.push(listKind === "ol"
      ? <ol key={"ol-" + blocks.length}>{items}</ol>
      : <ul key={"ul-" + blocks.length}>{items}</ul>);
    listItems = [];
    listKind = null;
  };
  const flushText = () => {
    flushParagraph();
    flushList();
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = line.match(/^\s{0,3}\x60\x60\x60([\w-]*)\s*$/);
    if (fence) {
      flushText();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s{0,3}\x60\x60\x60\s*$/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      blocks.push(<pre key={"code-" + blocks.length}><code>{code.join("\n")}</code></pre>);
      continue;
    }
    if (!line.trim()) {
      flushText();
      continue;
    }
    const heading = line.match(/^\s{0,3}(#{1,4})\s+(.+)$/);
    if (heading) {
      flushText();
      const level = Math.min(4, heading[1].length);
      const children = renderInlineMarkdown(heading[2]);
      if (level === 1) blocks.push(<h1 key={"h-" + blocks.length}>{children}</h1>);
      else if (level === 2) blocks.push(<h2 key={"h-" + blocks.length}>{children}</h2>);
      else if (level === 3) blocks.push(<h3 key={"h-" + blocks.length}>{children}</h3>);
      else blocks.push(<h4 key={"h-" + blocks.length}>{children}</h4>);
      continue;
    }
    if (/^\s{0,3}(?:---+|___+|\*\*\*+)\s*$/.test(line)) {
      flushText();
      blocks.push(<hr key={"hr-" + blocks.length} />);
      continue;
    }
    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      flushParagraph();
      const nextKind = ordered ? "ol" : "ul";
      if (listKind && listKind !== nextKind) flushList();
      listKind = nextKind;
      listItems.push((unordered || ordered)![1]);
      continue;
    }
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      flushText();
      blocks.push(<blockquote key={"quote-" + blocks.length}>{renderInlineMarkdown(quote[1])}</blockquote>);
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  flushText();

  return <div className="ud-markdown">{blocks}</div>;
}
