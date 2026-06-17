import { compressImageForUpload } from "./imageCompress.js";

export const MAX_TAPD_IMAGES = 8;

function resolveImgSrc(img: HTMLImageElement): string | null {
  const raw =
    img.getAttribute("src") ||
    img.getAttribute("data-src") ||
    img.getAttribute("data-original") ||
    img.currentSrc;

  if (raw && !raw.startsWith("data:")) {
    try {
      return new URL(raw, location.href).href;
    } catch {
      return raw;
    }
  }

  const srcset = img.getAttribute("srcset");
  if (srcset) {
    const first = srcset.split(",")[0]?.trim().split(/\s+/)[0];
    if (first) {
      try {
        return new URL(first, location.href).href;
      } catch {
        return first;
      }
    }
  }

  return img.src && !img.src.startsWith("data:") ? img.src : null;
}

async function blobFromCanvas(img: HTMLImageElement): Promise<Blob | null> {
  if (!img.complete) {
    await new Promise<void>((resolve) => {
      img.addEventListener("load", () => resolve(), { once: true });
      img.addEventListener("error", () => resolve(), { once: true });
    });
  }

  if (!img.naturalWidth || !img.naturalHeight) return null;

  try {
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0);
    return await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.9);
    });
  } catch {
    return null;
  }
}

async function fetchSingleTapdImage(img: HTMLImageElement): Promise<Blob | null> {
  const url = resolveImgSrc(img);
  if (url) {
    try {
      const res = await fetch(url, { credentials: "include" });
      if (res.ok) {
        const blob = await res.blob();
        if (blob.type.startsWith("image/")) return blob;
      }
    } catch {
      // fall through to canvas
    }
  }

  return blobFromCanvas(img);
}

/** 从 .content-wrap 内抓取配图（利用页面登录态），并压缩 */
export async function fetchTapdContentImages(root: Element): Promise<Blob[]> {
  const imgs = Array.from(root.querySelectorAll("img"));
  const blobs: Blob[] = [];

  for (const img of imgs) {
    if (blobs.length >= MAX_TAPD_IMAGES) break;

    const raw = await fetchSingleTapdImage(img);
    if (!raw) continue;

    try {
      blobs.push(await compressImageForUpload(raw));
    } catch {
      // skip failed compression
    }
  }

  return blobs;
}
