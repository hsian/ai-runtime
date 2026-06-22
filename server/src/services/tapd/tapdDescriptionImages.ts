import { config, getTapdConfig, type TapdConfig } from "../../config.js";
import {
  getTapdAttachmentDownloadUrl,
  getTapdImageDownloadUrl,
} from "./tapdClient.js";

export const MAX_TAPD_DESCRIPTION_IMAGES = 8;

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

function detectMime(buffer: Buffer, contentType: string | null): string | null {
  if (contentType && /^image\/(jpeg|jpg|png|webp|gif|bmp)$/i.test(contentType)) {
    return contentType.split(";")[0]!.toLowerCase().replace("jpg", "jpeg");
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return "image/png";
  }
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF") {
    return "image/webp";
  }
  if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return "image/bmp";
  }
  return null;
}

function normalizeTapdImagePath(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url.startsWith("/") ? url : `/${url}`;
  }
}

function parseTapdAttachmentId(url: string): string | null {
  const match = /\/attachments\/preview_attachments\/(\d+)\//i.exec(url);
  return match?.[1] ?? null;
}

function isTapdImagePath(pathOrUrl: string): boolean {
  return /\/(tfl|tdl)\//i.test(pathOrUrl) || /\/pictures\//i.test(pathOrUrl) || /\/captures\//i.test(pathOrUrl);
}

async function fetchBinary(url: string): Promise<{ buffer: Buffer; mime: string } | null> {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": "AI-Runtime/1.0", Referer: "https://www.tapd.cn/" },
    });
    if (!res.ok) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length === 0) return null;
    const mime = detectMime(buffer, res.headers.get("content-type"));
    if (!mime) return null;
    if (buffer.length > config.TAPD_IMAGE_MAX_BYTES) return null;
    return { buffer, mime: mime === "image/jpg" ? "image/jpeg" : mime };
  } catch {
    return null;
  }
}

async function resolveTapdImageUrl(
  imageUrl: string,
  workspaceId: string,
  cfg: TapdConfig
): Promise<string | null> {
  const attachmentId = parseTapdAttachmentId(imageUrl);
  if (attachmentId) {
    try {
      return await getTapdAttachmentDownloadUrl(workspaceId, attachmentId, cfg);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/scope limited/i.test(msg)) throw err;
    }
  }

  const path = normalizeTapdImagePath(imageUrl);
  if (isTapdImagePath(path) || imageUrl.includes("tapd")) {
    try {
      return await getTapdImageDownloadUrl(workspaceId, imageUrl, cfg);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/scope limited/i.test(msg)) {
        try {
          return await getTapdImageDownloadUrl(workspaceId, path, cfg);
        } catch (inner) {
          const innerMsg = inner instanceof Error ? inner.message : String(inner);
          if (!/scope limited/i.test(innerMsg)) throw inner;
        }
      }
    }
  }

  return null;
}

async function downloadSingleImage(
  imageUrl: string,
  workspaceId: string,
  cfg: TapdConfig
): Promise<{ buffer: Buffer; mime: string } | null> {
  const tapdDownloadUrl = await resolveTapdImageUrl(imageUrl, workspaceId, cfg);
  if (tapdDownloadUrl) {
    const fromTapd = await fetchBinary(tapdDownloadUrl);
    if (fromTapd) return fromTapd;
  }

  return fetchBinary(imageUrl);
}

export interface TapdDownloadedImage {
  dataUrl: string;
  mime: string;
  name: string;
  size: number;
}

export interface TapdImageDownloadReport {
  images: TapdDownloadedImage[];
  expected: number;
  failedUrls: string[];
}

export async function downloadImagesFromHtml(
  html: string,
  workspaceId?: string,
  cfg: TapdConfig = getTapdConfig()
): Promise<TapdImageDownloadReport> {
  const urls = extractImageUrlsFromHtml(html).slice(0, MAX_TAPD_DESCRIPTION_IMAGES);
  const wsId = workspaceId?.trim() || cfg.workspaceId;
  if (urls.length === 0) {
    return { images: [], expected: countImagesInHtml(html), failedUrls: [] };
  }

  const images: TapdDownloadedImage[] = [];
  const failedUrls: string[] = [];

  for (const [index, url] of urls.entries()) {
    const downloaded = await downloadSingleImage(url, wsId, cfg);
    if (!downloaded) {
      failedUrls.push(url);
      continue;
    }

    const ext =
      downloaded.mime === "image/png"
        ? "png"
        : downloaded.mime === "image/webp"
          ? "webp"
          : downloaded.mime === "image/gif"
            ? "gif"
            : "jpg";
    images.push({
      dataUrl: `data:${downloaded.mime};base64,${downloaded.buffer.toString("base64")}`,
      mime: downloaded.mime,
      name: `tapd-${index + 1}.${ext}`,
      size: downloaded.buffer.length,
    });

    if (images.length >= config.UPLOAD_MAX_COUNT) break;
  }

  return { images, expected: countImagesInHtml(html), failedUrls };
}

export function htmlToPlainPromptText(html: string): string {
  let imageIndex = 0;
  const withoutImgs = html.replace(/<img\b[^>]*>/gi, () => {
    imageIndex += 1;
    return ` [配图${imageIndex}] `;
  });
  const text = withoutImgs
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\s{2,}/g, " ")
    .trim();
  return text;
}
