export const MAX_ATTACHMENTS = 3;
const TARGET_BYTES = 180 * 1024;
const HARD_MAX_BYTES = 300 * 1024;
const MAX_WIDTH = 1400;

function imageFromBlob(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("无法读取图片"));
    };
    image.src = url;
  });
}

function toBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("图片压缩失败"))), "image/webp", quality);
  });
}

async function compressCanvas(canvas: HTMLCanvasElement): Promise<Blob> {
  let low = 0.42;
  let high = 0.92;
  let best: Blob | undefined;
  for (let index = 0; index < 9; index += 1) {
    const quality = (low + high) / 2;
    const blob = await toBlob(canvas, quality);
    if (blob.size <= TARGET_BYTES) {
      best = blob;
      low = quality;
    } else {
      high = quality;
    }
  }
  const result = best ?? (await toBlob(canvas, 0.42));
  if (result.size <= HARD_MAX_BYTES) return result;

  const smaller = document.createElement("canvas");
  smaller.width = Math.max(1, Math.round(canvas.width * 0.75));
  smaller.height = Math.max(1, Math.round(canvas.height * 0.75));
  smaller.getContext("2d")?.drawImage(canvas, 0, 0, smaller.width, smaller.height);
  return compressCanvas(smaller);
}

export async function compressImage(file: Blob): Promise<Blob> {
  if (file.size <= HARD_MAX_BYTES) return file;
  const image = await imageFromBlob(file);
  const scale = Math.min(1, MAX_WIDTH / image.width);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("无法创建图片画布");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return compressCanvas(canvas);
}
