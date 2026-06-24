import "../shared/styles.css";
import { loadConfig, saveConfig } from "../shared/config.js";

async function init(): Promise<void> {
  const config = await loadConfig();
  (document.getElementById("serverUrl") as HTMLInputElement).value = config.serverUrl;
  (document.getElementById("createMergeRequestOnMerge") as HTMLInputElement).checked =
    config.createMergeRequestOnMerge;

  document.getElementById("backLink")!.setAttribute("href", chrome.runtime.getURL("app.html"));

  document.getElementById("saveBtn")!.addEventListener("click", async () => {
    const serverUrl = (document.getElementById("serverUrl") as HTMLInputElement).value.trim();
    const createMergeRequestOnMerge = (
      document.getElementById("createMergeRequestOnMerge") as HTMLInputElement
    ).checked;
    const result = document.getElementById("saveResult")!;
    const resultText = document.getElementById("saveResultText")!;

    if (!serverUrl) {
      result.classList.remove("hidden");
      resultText.textContent = "请填写服务端地址";
      resultText.style.color = "#fca5a5";
      return;
    }

    await saveConfig({ serverUrl, createMergeRequestOnMerge });
    result.classList.remove("hidden");
    resultText.textContent = "已保存";
    resultText.style.color = "#86efac";
  });
}

init();
