import { compressImageForUpload, HARD_MAX_BYTES, MAX_ATTACHMENTS } from "./imageCompress.js";
import { normalizeServerUrl } from "./config.js";

interface SerializedTapdImage {
  dataUrl: string;
  mime?: string;
}

function dataUrlToBlob(dataUrl: string, typeHint?: string): Blob | null {
  const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl);
  if (!match) return null;
  const mime = typeHint || match[1] || "application/octet-stream";
  const payload = match[3] ?? "";
  const binary = match[2] ? atob(payload) : decodeURIComponent(payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function sniffImageMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46
  ) {
    return "image/webp";
  }
  if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return "image/gif";
  }
  return null;
}

async function fetchTapdDescriptionImagesFromServer(
  serverUrl: string,
  html: string,
  workspaceId?: string
): Promise<Blob[]> {
  const res = await fetch(`${normalizeServerUrl(serverUrl)}/api/tapd/images/from-html`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ html, workspaceId }),
  });
  const data = (await res.json()) as {
    images?: SerializedTapdImage[];
    error?: string;
    warning?: string;
  };
  if (!res.ok) {
    throw new Error(data.error ?? data.warning ?? `下载配图失败: ${res.status}`);
  }

  const blobs: Blob[] = [];
  for (const item of data.images ?? []) {
    const blob = dataUrlToBlob(item.dataUrl, item.mime);
    if (blob) blobs.push(blob);
  }
  return blobs;
}

const IMG_ATTR_PATTERNS = [
  /\ssrc=["']([^"']+)["']/i,
  /\sdata-src=["']([^"']+)["']/i,
  /\sdata-original=["']([^"']+)["']/i,
  /\sdata-mce-src=["']([^"']+)["']/i,
];

function decodeHtmlAttr(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .trim();
}

export function extractImageUrlsFromHtml(html: string, baseUrl = "https://www.tapd.cn"): string[] {
  if (!html?.trim()) return [];

  const urls: string[] = [];
  const imgTagRegex = /<img\b[^>]*>/gi;
  let tagMatch: RegExpExecArray | null;

  while ((tagMatch = imgTagRegex.exec(html)) !== null) {
    const tag = tagMatch[0];
    for (const pattern of IMG_ATTR_PATTERNS) {
      const attrMatch = pattern.exec(tag);
      if (!attrMatch?.[1]) continue;
      const raw = decodeHtmlAttr(attrMatch[1]);
      if (!raw || raw.startsWith("data:")) continue;
      try {
        urls.push(new URL(raw, baseUrl).href);
        break;
      } catch {
        if (/^https?:\/\//i.test(raw)) {
          urls.push(raw);
          break;
        }
        if (raw.startsWith("/")) {
          urls.push(new URL(raw, baseUrl).href);
          break;
        }
      }
    }
  }

  return urls;
}

export function countImagesInHtml(html: string): number {
  if (!html?.trim()) return 0;
  return (html.match(/<img\b/gi) ?? []).length;
}

async function buildTapdCookieHeader(): Promise<string | undefined> {
  if (!chrome.cookies?.getAll) return undefined;
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const domain of [".tapd.cn", "tapd.cn", "www.tapd.cn", "file.tapd.cn"]) {
    const list = await chrome.cookies.getAll({ domain });
    for (const cookie of list) {
      const pair = `${cookie.name}=${cookie.value}`;
      if (seen.has(pair)) continue;
      seen.add(pair);
      parts.push(pair);
    }
  }
  return parts.length > 0 ? parts.join("; ") : undefined;
}

async function fetchSingleTapdImageUrl(url: string): Promise<Blob | null> {
  const cookieHeader = await buildTapdCookieHeader();
  const headers: Record<string, string> = {
    Referer: "https://www.tapd.cn/",
    "User-Agent": "Mozilla/5.0",
  };
  if (cookieHeader) headers.Cookie = cookieHeader;

  try {
    const res = await fetch(url, {
      credentials: "include",
      redirect: "follow",
      headers,
    });
    if (!res.ok) return null;
    const buffer = await res.arrayBuffer();
    if (buffer.byteLength === 0 || buffer.byteLength > 8 * 1024 * 1024) return null;

    const bytes = new Uint8Array(buffer);
    const sniffed = sniffImageMime(bytes);
    if (sniffed) return new Blob([buffer], { type: sniffed });

    const headerType = res.headers.get("content-type")?.split(";")[0]?.trim();
    if (headerType?.startsWith("image/")) {
      return new Blob([buffer], { type: headerType });
    }
    return null;
  } catch {
    return null;
  }
}

/** 浏览器侧回退：用 tapd.cn 登录 Cookie 直接拉描述里的图片 URL */
async function fetchTapdImagesViaBrowser(html: string): Promise<Blob[]> {
  const urls = extractImageUrlsFromHtml(html);
  const blobs: Blob[] = [];

  for (const url of urls) {
    if (blobs.length >= MAX_ATTACHMENTS) break;
    if (!/tapd\.(cn|com)/i.test(url)) continue;
    const blob = await fetchSingleTapdImageUrl(url);
    if (blob) blobs.push(blob);
  }

  return blobs;
}

export const TAPD_IMAGE_PROMPT_SUFFIX = `

【配图说明 — 必须遵守】
任务描述中的「如图N」「图N」「[配图N]」均指第 N 张配图，与随任务上传的附件「图N」路径一一对应（如图2 = 图2 = 配图2）。
Plan 阶段分析某段需求时，若文字提到「如图N」，必须先 Read 对应编号的附件图片，再写该段方案。
执行修改阶段优先按已确认方案实现；仅当方案未覆盖截图细节、或实现该段需求必须核对 UI 时，再 Read 对应编号的附件图片。`;

export function appendTapdImageInstructions(prompt: string, imageCount: number): string {
  const trimmed = prompt.trim();
  if (imageCount <= 0 || trimmed.includes("【配图说明")) return trimmed;
  return `${trimmed}${TAPD_IMAGE_PROMPT_SUFFIX}\n（本次已附带 ${imageCount} 张配图）`;
}

export interface PrepareTapdImagesResult {
  images: Blob[];
  expectedInHtml: number;
  downloadFailed: boolean;
}

export async function prepareTapdJobImages(
  serverUrl: string,
  sourceHtml?: string,
  workspaceId?: string
): Promise<PrepareTapdImagesResult> {
  const expectedInHtml = countImagesInHtml(sourceHtml ?? "");
  if (!sourceHtml?.trim() || expectedInHtml === 0) {
    return { images: [], expectedInHtml: 0, downloadFailed: false };
  }

  let raw: Blob[] = [];
  try {
    // 优先走服务端 TAPD API（附件权限即可换临时下载链，不依赖浏览器 Cookie）
    raw = await fetchTapdDescriptionImagesFromServer(serverUrl, sourceHtml, workspaceId);
    if (raw.length === 0) {
      raw = await fetchTapdImagesViaBrowser(sourceHtml);
    }
  } catch {
    try {
      raw = await fetchTapdImagesViaBrowser(sourceHtml);
    } catch {
      return { images: [], expectedInHtml, downloadFailed: true };
    }
  }

  const images: Blob[] = [];
  for (const blob of raw) {
    if (images.length >= MAX_ATTACHMENTS) break;
    try {
      images.push(await compressImageForUpload(blob));
    } catch {
      if (blob.size > 0 && blob.size <= HARD_MAX_BYTES) {
        images.push(blob.type.startsWith("image/") ? blob : new Blob([blob], { type: "image/png" }));
      }
    }
  }

  return {
    images,
    expectedInHtml,
    downloadFailed: images.length === 0,
  };
}
