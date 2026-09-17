import { load } from "cheerio";
import sanitizeHtml from "sanitize-html";

import type { TapdComment } from "./tapdClient.js";

const MAX_EDITABLE_HTML_CHARS = 1_000_000;
const MAX_DESCRIPTION_CHARS = 50_000;
const MAX_TAPD_IMAGES = 100;

const allowedTags = [
  "p", "div", "section", "article", "span", "br", "strong", "b", "em", "i", "u", "s", "del",
  "blockquote", "pre", "code", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li",
  "table", "thead", "tbody", "tr", "th", "td", "a", "img", "hr",
];

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function cleanTapdEditableHtml(html: string): string {
  return sanitizeHtml(html.slice(0, MAX_EDITABLE_HTML_CHARS), {
    allowedTags,
    allowedAttributes: {
      a: ["href", "title", "target"],
      img: ["src", "alt", "title", "data-source-index"],
      td: ["colspan", "rowspan"],
      th: ["colspan", "rowspan"],
    },
    allowedSchemes: ["http", "https"],
    allowProtocolRelative: false,
    transformTags: {
      a: (_tagName, attributes) => ({ tagName: "a", attribs: { ...attributes, target: "_blank" } }),
    },
  });
}

export function buildTapdEditableHtml(sourceHtml: string, comments: TapdComment[]): string {
  const commentHtml = comments.length > 0
    ? comments.map((comment, index) => {
        const metadata = [comment.author || "未知用户", comment.created || comment.modified || "时间未知"]
          .map(escapeHtml)
          .join(" · ");
        const title = comment.title?.trim() ? ` · ${escapeHtml(comment.title.trim())}` : "";
        return `<article><h3>评论 ${index + 1} · ${metadata}${title}</h3>${comment.description?.trim() || "<p>（评论内容为空）</p>"}</article>`;
      }).join("<hr>")
    : "<p>（暂无评论）</p>";
  const combined = `<section><h2>需求描述</h2>${sourceHtml.trim() || "<p>（需求正文为空）</p>"}</section><hr><section><h2>评论与补充（${comments.length}）</h2>${commentHtml}</section>`;
  const $ = load(cleanTapdEditableHtml(combined), undefined, false);
  $("img").each((index, element) => {
    if (index >= MAX_TAPD_IMAGES) {
      $(element).replaceWith("<span>[超过上限的 TAPD 配图已忽略]</span>");
      return;
    }
    $(element).attr("data-source-index", String(index + 1));
  });
  return cleanTapdEditableHtml($.html());
}

export interface NormalizedTapdEditableContent {
  html: string;
  description: string;
  retainedImageIndexes: number[];
}

export function normalizeTapdEditableContent(html: string): NormalizedTapdEditableContent {
  const cleaned = cleanTapdEditableHtml(html);
  const $ = load(cleaned, undefined, false);
  const retainedImageIndexes: number[] = [];

  $("img").each((_index, element) => {
    const sourceIndex = Number.parseInt($(element).attr("data-source-index") || "", 10);
    if (!Number.isInteger(sourceIndex) || sourceIndex < 1 || sourceIndex > MAX_TAPD_IMAGES || retainedImageIndexes.includes(sourceIndex)) {
      $(element).remove();
      return;
    }
    retainedImageIndexes.push(sourceIndex);
    $(element)
      .attr("data-source-index", String(sourceIndex))
      .removeAttr("src")
      .removeAttr("style")
      .removeAttr("class");
  });

  const normalizedHtml = cleanTapdEditableHtml($.html());
  const textDom = load(normalizedHtml, undefined, false);
  textDom("script, style").remove();
  textDom("img").each((index, element) => {
    textDom(element).replaceWith(` [配图${index + 1}] `);
  });
  textDom("br").replaceWith("\n");
  textDom("li").each((_index, element) => {
    textDom(element).prepend("\n- ").append("\n");
  });
  textDom("p,div,section,article,h1,h2,h3,h4,h5,h6,tr,blockquote,pre").each((_index, element) => {
    textDom(element).append("\n");
  });
  const description = textDom.root().text()
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim()
    .slice(0, MAX_DESCRIPTION_CHARS);

  return { html: normalizedHtml, description, retainedImageIndexes };
}
