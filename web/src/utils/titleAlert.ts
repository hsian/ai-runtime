const defaultTitle = document.title;
const SCROLL_INTERVAL_MS = 400;
let scrollTimer: number | undefined;

export function stopTitleAlert(): void {
  if (scrollTimer !== undefined) {
    window.clearInterval(scrollTimer);
    scrollTimer = undefined;
  }
  document.title = defaultTitle;
}

export function startTitleAlert(message: string): void {
  if (document.visibilityState === "visible") return;

  stopTitleAlert();
  const characters = Array.from(`【${message}】　${defaultTitle}　　`);
  let offset = 0;
  const render = () => {
    document.title = [
      ...characters.slice(offset),
      ...characters.slice(0, offset),
    ].join("");
    offset = (offset + 1) % characters.length;
  };
  render();
  scrollTimer = window.setInterval(render, SCROLL_INTERVAL_MS);
}
