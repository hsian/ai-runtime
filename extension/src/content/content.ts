import { extractTapdRequirementInPage } from "../shared/tapdPageExtract.js";

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
    sendResponse(extractTapdRequirementInPage());
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
