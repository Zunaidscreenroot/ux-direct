import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownContent } from "../src/components/markdown-content";

test("assistant Markdown renders bold, lists, inline code and fenced code as formatted HTML", () => {
  const html = renderToStaticMarkup(createElement(MarkdownContent, {
    content: "**Important** detail\n\n- First item\n- Second item with `value`\n\n```ts\nconst answer = 42;\n```"
  }));
  assert.match(html, /<strong>Important<\/strong>/);
  assert.match(html, /<ul>/);
  assert.match(html, /<li>Second item with <code>value<\/code><\/li>/);
  assert.match(html, /<pre><code>const answer = 42;/);
  assert.equal(html.includes("**Important**"), false);
});

test("assistant Markdown escapes HTML and only creates HTTP(S) links", () => {
  const html = renderToStaticMarkup(createElement(MarkdownContent, {
    content: "Use **bold** and [official docs](https://example.com/docs). <script>alert(1)</script>"
  }));
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /href="https:\/\/example\.com\/docs"/);
  assert.equal(html.includes("<script>"), false);
  assert.match(html, /&lt;script&gt;/);
});
