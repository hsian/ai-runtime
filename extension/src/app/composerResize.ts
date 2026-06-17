const STORAGE_KEY = "composerFooterHeight";
const DEFAULT_HEIGHT = 196;
const MIN_HEIGHT = 128;
const MAX_HEIGHT_RATIO = 0.72;

function clampFooterHeight(height: number): number {
  const maxHeight = Math.floor(window.innerHeight * MAX_HEIGHT_RATIO);
  return Math.min(maxHeight, Math.max(MIN_HEIGHT, height));
}

export function setupComposerResize(): void {
  const footer = document.getElementById("chatFooter");
  const resizer = document.getElementById("footerResizer");
  if (!footer || !resizer) return;

  const applyHeight = (height: number): void => {
    footer.style.height = `${clampFooterHeight(height)}px`;
  };

  void chrome.storage.local.get([STORAGE_KEY]).then((stored) => {
    const saved = stored[STORAGE_KEY];
    applyHeight(typeof saved === "number" ? saved : DEFAULT_HEIGHT);
  });

  let startY = 0;
  let startHeight = 0;

  resizer.addEventListener("mousedown", (event) => {
    event.preventDefault();
    startY = event.clientY;
    startHeight = footer.offsetHeight;
    document.body.classList.add("composer-resizing");

    const onMove = (moveEvent: MouseEvent): void => {
      const delta = startY - moveEvent.clientY;
      applyHeight(startHeight + delta);
    };

    const onUp = (): void => {
      document.body.classList.remove("composer-resizing");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      void chrome.storage.local.set({ [STORAGE_KEY]: footer.offsetHeight });
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}
