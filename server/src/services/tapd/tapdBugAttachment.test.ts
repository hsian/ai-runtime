import assert from "node:assert/strict";
import test from "node:test";

import { uploadBugAttachment } from "./tapdClient.js";

const cfg = {
  apiBase: "https://api.tapd.cn",
  clientId: "test-client",
  clientSecret: "test-secret",
  workspaceId: "123",
  workspaces: [{ id: "123" }],
};

test("uploads a bug screenshot as a multipart attachment", async () => {
  const originalFetch = globalThis.fetch;
  let uploadChecked = false;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/tokens/request_token")) {
      return Response.json({ status: 1, data: { access_token: "test-token", expires_in: 3600 } });
    }
    assert.equal(url, "https://api.tapd.cn/files/upload_attachment");
    assert.equal(init?.method, "POST");
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer test-token");
    const body = init?.body as FormData;
    assert.equal(body.get("workspace_id"), "123");
    assert.equal(body.get("type"), "bug");
    assert.equal(body.get("entry_id"), "456");
    assert.equal((body.get("file") as File).name, "screen.png");
    uploadChecked = true;
    return Response.json({ status: 1, data: { Attachment: { id: "789" } } });
  };
  try {
    const id = await uploadBugAttachment({
      workspaceId: "123", bugId: "456", filename: "screen.png", mimeType: "image/png", data: Buffer.from("image"),
    }, cfg);
    assert.equal(id, "789");
    assert.equal(uploadChecked, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
