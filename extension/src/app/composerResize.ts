const DEFAULT_HEIGHT = 140;
const MIN_HEIGHT = 140;
const MAX_HEIGHT_RATIO = 0.72;

function clampFooterHeight(height: number): number {
  const maxHeight = Math.floor(window.innerHeight * MAX_HEIGHT_RATIO);
  return Math.min(maxHeight, Math.max(MIN_HEIGHT, height));
}

export interface ComposerResizeOptions {
  footerId?: string;
  resizerId?: string;
  storageKey?: string;
}

export function setupComposerResize(options: ComposerResizeOptions = {}): void {
  const footer = document.getElementById(options.footerId ?? "chatFooter");
  const resizer = document.getElementById(options.resizerId ?? "footerResizer");
  const storageKey = options.storageKey ?? "composerFooterHeight";
  if (!footer || !resizer) return;

  const applyHeight = (height: number): void => {
    footer.style.height = `${clampFooterHeight(height)}px`;
  };

  void chrome.storage.local.get([storageKey]).then((stored) => {
    const saved = stored[storageKey];
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
      void chrome.storage.local.set({ [storageKey]: footer.offsetHeight });
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}
