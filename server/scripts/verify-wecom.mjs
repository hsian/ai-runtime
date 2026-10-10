import { getWecomConfig } from "../dist/modules/wecom/config.js";
import { createWecomClient } from "../dist/modules/wecom/client.js";

// Authenticate only: do not receive commands, create jobs, or send messages.
const options = getWecomConfig();
if (!options) {
  console.error("[WeCom verify] QWECHAT_BOT_ENABLED is false");
  process.exitCode = 1;
} else {
  const client = createWecomClient(options);
  await new Promise(resolve => {
    let finished = false;
    const finish = (success, message) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      client.disconnect();
      console.log(`[WeCom verify] ${message}`);
      if (!success) process.exitCode = 1;
      resolve();
    };
    const timer = setTimeout(() => finish(false, "Authentication timed out"), 15_000);
    client.on("authenticated", () => finish(true, `Authenticated; project=${options.projectId}`));
    client.on("error", () => finish(false, "Connection or authentication failed; check credentials and network"));
    client.connect();
  });
}
