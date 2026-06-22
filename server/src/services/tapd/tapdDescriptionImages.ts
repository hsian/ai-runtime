import { config, getTapdConfig, type TapdConfig } from "../../config.js";
import { getAccessToken } from "./tapdClient.js";

export const MAX_TAPD_DESCRIPTION_IMAGES = 8;

const IMG_ATTR_PATTERNS = [
  /\ssrc=["']([^"']+)["']/i,
  /\sdata-src=["']([^"']+)["']/i,
  /\sdata-original=["']([^"']+)["']/i,
];

export function extractImageUrlsFromHtml(html: string, baseUrl = "https://www.tapd.cn"): string[] {
  if (!html?.trim()) return [];

  const urls = new Set<string>();
  const imgTagRegex = /<img\b[^>]*>/gi;
  let tagMatch: RegExpExecArray | null;

  while ((tagMatch = imgTagRegex.exec(html)) !== null) {
    const tag = tagMatch[0];
    for (const pattern of IMG_ATTR_PATTERNS) {
      const attrMatch = pattern.exec(tag);
      if (!attrMatch?.[1]) continue;
      const raw = attrMatch[1].trim();
      if (!raw || raw.startsWith("data:")) continue;
      try {
        urls.add(new URL(raw, baseUrl).href);
      } catch {
        if (/^https?:\/\//i.test(raw)) urls.add(raw);
      }
    }
  }

  return [...urls];
}

export function countImagesInHtml(html: string): number {
  return extractImageUrlsFromHtml(html).length;
}

function detectMime(buffer: Buffer, contentType: string | null): string | null {
  if (contentType && /^image\/(jpeg|jpg|png|webp|gif)$/i.test(contentType)) {
    return contentType.split(";")[0]!.toLowerCase();
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
  return null;
}

async function downloadSingleImage(
  url: string,
  token: string
): Promise<{ buffer: Buffer; mime: string } | null> {
  const headerSets: Record<string, string>[] = [
    { Authorization: `Bearer ${token}`, "User-Agent": "AI-Runtime/1.0", Referer: "https://www.tapd.cn/" },
    { "User-Agent": "AI-Runtime/1.0", Referer: "https://www.tapd.cn/" },
  ];

  for (const headers of headerSets) {
    try {
      const res = await fetch(url, { headers, redirect: "follow" });
      if (!res.ok) continue;
      const buffer = Buffer.from(await res.arrayBuffer());
      if (buffer.length === 0) continue;
      const mime = detectMime(buffer, res.headers.get("content-type"));
      if (!mime) continue;
      if (buffer.length > config.UPLOAD_MAX_BYTES) continue;
      return { buffer, mime };
    } catch {
      // try next header set
    }
  }
  return null;
}

export interface TapdDownloadedImage {
  dataUrl: string;
  mime: string;
  name: string;
  size: number;
}

export async function downloadImagesFromHtml(
  html: string,
  cfg: TapdConfig = getTapdConfig()
): Promise<TapdDownloadedImage[]> {
  const urls = extractImageUrlsFromHtml(html).slice(0, MAX_TAPD_DESCRIPTION_IMAGES);
  if (urls.length === 0) return [];

  const token = await getAccessToken(cfg);
  const images: TapdDownloadedImage[] = [];

  for (const [index, url] of urls.entries()) {
    const downloaded = await downloadSingleImage(url, token);
    if (!downloaded) continue;

    const ext = downloaded.mime === "image/png" ? "png" : downloaded.mime === "image/webp" ? "webp" : "jpg";
    images.push({
      dataUrl: `data:${downloaded.mime};base64,${downloaded.buffer.toString("base64")}`,
      mime: downloaded.mime,
      name: `tapd-${index + 1}.${ext}`,
      size: downloaded.buffer.length,
    });

    if (images.length >= config.UPLOAD_MAX_COUNT) break;
  }

  return images;
}

export function htmlToPlainPromptText(html: string): string {
  const withoutImgs = html.replace(/<img\b[^>]*>/gi, " [配图] ");
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
