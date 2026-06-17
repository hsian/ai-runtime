export interface TapdExtractResult {
  ok: boolean;
  error?: string;
  data?: {
    url: string;
    title: string;
    contentText: string;
    extractedAt: string;
  };
}

/** 须在页面上下文中运行；所有逻辑内聚在一个函数体内，便于 scripting.executeScript 注入 */
export function extractTapdRequirementInPage(): TapdExtractResult {
  function sanitizeRequirementDom(root: HTMLElement): void {
    root.querySelectorAll("script, style, iframe, noscript").forEach((node) => node.remove());

    root.querySelectorAll("a").forEach((anchor) => {
      const text = anchor.textContent?.trim() || "";
      const span = document.createElement("span");
      span.textContent = text;
      anchor.replaceWith(span);
    });

    root.querySelectorAll("img").forEach((img) => {
      const alt = img.getAttribute("alt")?.trim();
      const placeholder = document.createElement("span");
      placeholder.textContent = alt ? `[图片: ${alt}]` : "[图片]";
      img.replaceWith(placeholder);
    });
  }

  function domToStructuredText(root: HTMLElement): string {
    const blocks: string[] = [];

    function walk(node: Node): void {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent?.replace(/\s+/g, " ").trim();
        if (text) blocks.push(text);
        return;
      }

      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const el = node as HTMLElement;
      const tag = el.tagName.toLowerCase();

      if (tag === "br") {
        blocks.push("\n");
        return;
      }

      const isBlock = /^(p|div|li|tr|h[1-6]|section|article|table|thead|tbody|ul|ol|blockquote|pre)$/.test(
        tag
      );
      if (isBlock) blocks.push("\n");

      if (/^h[1-6]$/.test(tag)) {
        const level = Number(tag[1]);
        blocks.push(`${"#".repeat(level)} `);
      }

      if (tag === "li") blocks.push("- ");

      for (const child of el.childNodes) {
        walk(child);
      }

      if (isBlock) blocks.push("\n");
    }

    walk(root);

    return blocks
      .join("")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  const root = document.querySelector(".content-wrap");
  if (!root) {
    return {
      ok: false,
      error: "未找到 .content-wrap，请确认当前是 TAPD 需求详情页且页面已加载完成",
    };
  }

  const clone = root.cloneNode(true) as HTMLElement;
  sanitizeRequirementDom(clone);
  const contentText = domToStructuredText(clone).trim();

  if (!contentText) {
    return { ok: false, error: "需求内容为空，请确认 .content-wrap 内有正文" };
  }

  return {
    ok: true,
    data: {
      url: location.href,
      title: document.title,
      contentText,
      extractedAt: new Date().toISOString(),
    },
  };
}

export function isTapdUrl(url: string | undefined): boolean {
  if (!url) return false;
  return /:\/\/([^/]+\.)?tapd\.(cn|woa\.com|tencent\.com)\b/i.test(url);
}

export const TAPD_TAB_URL_PATTERNS = [
  "*://*.tapd.cn/*",
  "*://tapd.cn/*",
  "*://*.tapd.woa.com/*",
  "*://*.tapd.tencent.com/*",
];
