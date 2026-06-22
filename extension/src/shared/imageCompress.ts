export const MAX_ATTACHMENTS = 3;
export const TARGET_BYTES = 180 * 1024;
export const HARD_MAX_BYTES = 300 * 1024;
export const MAX_WIDTH = 1400;

function loadImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("无法读取图片"));
    };
    img.src = url;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("图片压缩失败"));
          return;
        }
        resolve(blob);
      },
      type,
      quality
    );
  });
}

function drawScaledImage(img: HTMLImageElement, maxWidth: number): HTMLCanvasElement {
  let width = img.width;
  let height = img.height;

  if (width > maxWidth) {
    height = Math.round((height * maxWidth) / width);
    width = maxWidth;
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建画布");
  ctx.drawImage(img, 0, 0, width, height);
  return canvas;
}

async function compressDomCanvas(canvas: HTMLCanvasElement, maxBytes: number): Promise<Blob> {
  let lo = 0.45;
  let hi = 0.92;
  let best: Blob | null = null;

  for (let i = 0; i < 10; i++) {
    const quality = (lo + hi) / 2;
    const blob = await canvasToBlob(canvas, "image/webp", quality);
    if (blob.size <= maxBytes) {
      best = blob;
      lo = quality;
    } else {
      hi = quality;
    }
  }

  if (!best) {
    best = await canvasToBlob(canvas, "image/webp", 0.45);
  }

  if (best.size > HARD_MAX_BYTES) {
    const smaller = document.createElement("canvas");
    smaller.width = Math.round(canvas.width * 0.75);
    smaller.height = Math.round(canvas.height * 0.75);
    const ctx = smaller.getContext("2d");
    if (!ctx) throw new Error("无法创建画布");
    ctx.drawImage(canvas, 0, 0, smaller.width, smaller.height);
    return compressDomCanvas(smaller, maxBytes);
  }

  return best;
}

async function compressOffscreenCanvas(
  canvas: OffscreenCanvas,
  maxBytes: number
): Promise<Blob> {
  let lo = 0.45;
  let hi = 0.92;
  let best: Blob | null = null;

  for (let i = 0; i < 10; i++) {
    const quality = (lo + hi) / 2;
    const blob = await canvas.convertToBlob({ type: "image/webp", quality });
    if (blob.size <= maxBytes) {
      best = blob;
      lo = quality;
    } else {
      hi = quality;
    }
  }

  if (!best) {
    best = await canvas.convertToBlob({ type: "image/webp", quality: 0.45 });
  }

  if (best.size > HARD_MAX_BYTES) {
    const smaller = new OffscreenCanvas(
      Math.round(canvas.width * 0.75),
      Math.round(canvas.height * 0.75)
    );
    const ctx = smaller.getContext("2d");
    if (!ctx) throw new Error("无法创建画布");
    ctx.drawImage(canvas, 0, 0, smaller.width, smaller.height);
    return compressOffscreenCanvas(smaller, maxBytes);
  }

  return best;
}

async function compressWithOffscreen(source: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(source);
  let width = bitmap.width;
  let height = bitmap.height;
  if (width > MAX_WIDTH) {
    height = Math.round((height * MAX_WIDTH) / width);
    width = MAX_WIDTH;
  }
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建画布");
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return compressOffscreenCanvas(canvas, TARGET_BYTES);
}

export async function compressImageForUpload(source: Blob): Promise<Blob> {
  if (source.size > 0 && source.size <= HARD_MAX_BYTES && source.type.startsWith("image/")) {
    return source;
  }

  if (typeof OffscreenCanvas !== "undefined" && typeof createImageBitmap === "function") {
    return compressWithOffscreen(source);
  }

  const img = await loadImage(source);
  const canvas = drawScaledImage(img, MAX_WIDTH);
  return compressDomCanvas(canvas, TARGET_BYTES);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${Math.round(bytes / 1024)} KB`;
}
