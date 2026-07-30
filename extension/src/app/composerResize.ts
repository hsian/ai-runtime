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
  scrollContainerId?: string;
}

export function setupComposerResize(options: ComposerResizeOptions = {}): void {
  const footer = document.getElementById(options.footerId ?? "chatFooter");
  const resizer = document.getElementById(options.resizerId ?? "footerResizer");
  const storageKey = options.storageKey ?? "composerFooterHeight";
  if (!footer || !resizer) return;

  const scrollContainer = options.scrollContainerId
    ? document.getElementById(options.scrollContainerId)
    : null;
  if (scrollContainer) {
    const alignWithScrollContent = (): void => {
      const scrollbarWidth = Math.max(0, scrollContainer.offsetWidth - scrollContainer.clientWidth);
      footer.style.marginRight = `${scrollbarWidth}px`;
    };
    const resizeObserver = new ResizeObserver(alignWithScrollContent);
    const mutationObserver = new MutationObserver(alignWithScrollContent);
    resizeObserver.observe(scrollContainer);
    mutationObserver.observe(scrollContainer, { childList: true, subtree: true });
    alignWithScrollContent();
  }

  let preferredHeight = DEFAULT_HEIGHT;
  let autoMinHeight = MIN_HEIGHT;

  const renderHeight = (): void => {
    footer.style.height = `${Math.max(clampFooterHeight(preferredHeight), autoMinHeight)}px`;
  };

  const applyHeight = (height: number): void => {
    preferredHeight = clampFooterHeight(height);
    renderHeight();
  };

  void chrome.storage.local.get([storageKey]).then((stored) => {
    const saved = stored[storageKey];
    applyHeight(typeof saved === "number" ? saved : DEFAULT_HEIGHT);
  });

  footer.addEventListener("composer-auto-min-height", (event) => {
    const requested = (event as CustomEvent<number>).detail;
    autoMinHeight = clampFooterHeight(
      typeof requested === "number" ? requested : MIN_HEIGHT
    );
    renderHeight();
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
      void chrome.storage.local.set({ [storageKey]: preferredHeight });
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
}
