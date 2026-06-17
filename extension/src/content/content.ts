import { extractTapdRequirementInPage } from "../shared/tapdPageExtract.js";
import { fetchTapdContentImages } from "../shared/tapdImageExtract.js";

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("图片读取失败"));
    reader.readAsDataURL(blob);
  });
}

async function serializeImageBlobs(blobs: Blob[]): Promise<
  Array<{
    dataUrl: string;
    type: string;
    name: string;
  }>
> {
  const images: Array<{ dataUrl: string; type: string; name: string }> = [];
  for (const [index, blob] of blobs.entries()) {
    try {
      images.push({
        dataUrl: await blobToDataUrl(blob),
        type: blob.type || "image/webp",
        name: `tapd-${index + 1}.webp`,
      });
    } catch {
      // 跳过损坏或无法读取的单张配图，不影响正文整理。
    }
  }
  return images;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "GET_PAGE_CONTEXT") {
    const selection = window.getSelection();
    const selectedText = selection?.toString().trim() || undefined;
    let selectedSelector: string | undefined;

    if (selection?.anchorNode) {
      const el =
        selection.anchorNode.nodeType === Node.ELEMENT_NODE
          ? (selection.anchorNode as Element)
          : selection.anchorNode.parentElement;
      if (el) {
        selectedSelector = buildSelector(el);
      }
    }

    sendResponse({
      url: location.href,
      title: document.title,
      selectedText,
      selectedSelector,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    });
    return true;
  }

  if (message.type === "GET_TAPD_REQUIREMENT") {
    void (async () => {
      const root = document.querySelector(".content-wrap");
      const imageBlobs = root ? await fetchTapdContentImages(root) : [];
      const images = await serializeImageBlobs(imageBlobs);
      const result = extractTapdRequirementInPage();
      if (!result.ok || !result.data) {
        sendResponse(result);
        return;
      }

      sendResponse({
        ok: true,
        data: {
          ...result.data,
          imageCount: images.length,
        },
        imageBlobs: images,
      });
    })();
    return true;
  }
});

function buildSelector(el: Element): string {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const tag = el.tagName.toLowerCase();
  const classes = Array.from(el.classList)
    .slice(0, 2)
    .map((c) => `.${CSS.escape(c)}`)
    .join("");
  return classes ? `${tag}${classes}` : tag;
}
