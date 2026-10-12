import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WSClient } from "@wecom/aibot-node-sdk";
import type { MessageFrame } from "./client.js";
import type { Command } from "./commands.js";

const directory = mkdtempSync(join(tmpdir(), "wecom-images-test-"));
process.env.DATABASE_PATH = join(directory, "test.sqlite");
process.env.UPLOAD_DIR = join(directory, "uploads");
process.env.GIT_ACCESS_TOKEN = "test-only";
process.env.OPERATION_LOG_ENABLED = "false";
const { extractMessageContent, downloadMessageImages } = await import("./messageImages.js");
const { createMessageHandler } = await import("./messageHandler.js");
const { parseCommand } = await import("./commands.js");
const store = await import("./sessionStore.js");
const { closeDatabase } = await import("../../services/database.js");
const { dispatchCommand } = await import("./jobBridge.js");
const { getJob } = await import("../../services/jobStore.js");
const { saveImageBuffers } = await import("../../services/uploadService.js");
store.initWecomStore();
after(() => { closeDatabase(); rmSync(directory, { recursive: true, force: true }); });
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6ZAAAAABJRU5ErkJggg==", "base64");
const image = { url: "https://work.weixin.qq.com/image", aeskey: "secret-image-key" };
const options = { botId: "images-bot", secret: "test", projectId: "b2b-composite", codeAllowedUserIds: ["alice"] };
function frame(id: string, text?: string): MessageFrame {
  return { headers: { req_id: id }, body: { aibotid: options.botId, msgid: id, from: { userid: "alice" }, chattype: "single",
    msgtype: text === undefined ? "image" : "mixed", image,
    mixed: { msg_item: [{ msgtype: "text", text: { content: text } }, { msgtype: "image", image }] } } } as MessageFrame;
}

test("mixed messages preserve text order, prefixes and every image", () => {
  const message = frame("extract", "#codex");
  message.body!.mixed.msg_item.push({ msgtype: "text", text: { content: "复制合同这个不用置灰" } }, { msgtype: "image", image });
  assert.deepEqual(extractMessageContent(message.body!), { text: "#codex\n复制合同这个不用置灰", images: [image, image] });
  assert.deepEqual(extractMessageContent(frame("pure").body!), { text: "", images: [image] });
});

test("download uses per-image keys, recognizes bytes and rejects failed or unsafe images", async () => {
  const downloader = { async downloadFile(url: string, key?: string) {
    assert.equal(url, image.url); assert.equal(key, image.aeskey);
    return { buffer: png, filename: "untrusted.html" };
  } };
  assert.deepEqual(await downloadMessageImages(downloader, [image]), [{ name: "wecom-image-1.png", mime: "image/png", buffer: png }]);
  await assert.rejects(downloadMessageImages(downloader, [{ ...image, url: "https://127.0.0.1/private" }]), /第 1 张图片读取失败/);
  await assert.rejects(downloadMessageImages({ async downloadFile() { return { buffer: Buffer.from("not an image") }; } }, [image]), /无法识别.*未提交任务/);
  await assert.rejects(downloadMessageImages(downloader, Array(10).fill(image)), /最多支持 9/);
});

test("normal screenshots over 300KB and Tencent image CDN URLs work without changing Web upload limits", async () => {
  const large = Buffer.concat([png, Buffer.alloc(400 * 1024)]);
  const result = await downloadMessageImages({ async downloadFile() { return { buffer: large }; } }, [{ ...image, url: "https://wework.qpic.cn/signed-image" }]);
  const { WECOM_IMAGE_MAX_BYTES } = await import("./messageImages.js");
  const id = "87654321-1234-1234-1234-123456789abc";
  assert.equal(saveImageBuffers(id, result, WECOM_IMAGE_MAX_BYTES)[0].sizeBytes, large.length);
  assert.throws(() => saveImageBuffers("87654321-1234-1234-1234-123456789abd", result), /Invalid image attachment/);
  await assert.rejects(downloadMessageImages({ async downloadFile() { return { buffer: Buffer.alloc(WECOM_IMAGE_MAX_BYTES + 1) }; } }, [image]), /不能超过 10MB/);
});

test("handler passes actual image bytes with Codex and project selection and cleans temporary files", async () => {
  const calls: string[] = [];
  const dispatched: Command[] = [];
  const paths: string[] = [];
  let downloads = 0;
  const client = { async downloadFile() { downloads++; return { buffer: png }; },
    async replyStream(_frame: unknown, _id: string, text: string) { calls.push(text); } } as unknown as WSClient;
  const handler = createMessageHandler(client, options, async command => command,
    async (_session, content) => ({ command: parseCommand(content) }), undefined,
    async (session, command, messageKey, taskOptions, _onJob, attachments) => {
      dispatched.push(command);
      assert.ok(session.session_key.includes(taskOptions.projectId));
      assert.equal(attachments?.length, 1);
      paths.push(attachments![0].path);
      assert.deepEqual(readFileSync(attachments![0].path), png);
      store.rememberMessage(messageKey);
      return "图片已传入任务";
    });
  try {
    const mixed = frame("mixed-task", "#codex #小程序 修改：复制合同这个不用置灰");
    handler.handle(mixed); handler.handle(mixed);
    handler.handle(frame("pure-task"));
    handler.handle(frame("prefix-image", "#codex"));
    for (let count = 0; count < 100 && dispatched.length < 3; count++) await new Promise(resolve => setTimeout(resolve, 10));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(downloads, 3);
    assert.equal(dispatched[0].action, "plan");
    assert.equal(dispatched[0].agentProvider, "codex");
    assert.equal(dispatched[0].projectId, "yuenongjiao-mini");
    assert.equal(dispatched[1].action, "question");
    assert.equal(dispatched[2].action, "question");
    assert.equal(dispatched[2].agentProvider, "codex");
    assert.ok(paths.every(path => !existsSync(path)));
    assert.equal(calls.filter(text => text === "图片已传入任务").length, 3);
  } finally { handler.stop(); }
});

test("image failure stops routing and dispatch instead of submitting text alone", async () => {
  const calls: string[] = [];
  const client = { async downloadFile() { throw new Error("secret download URL and key"); },
    async replyStream(_frame: unknown, _id: string, text: string) { calls.push(text); } } as unknown as WSClient;
  const handler = createMessageHandler(client, options, async () => { throw new Error("must not route"); },
    async (_session, content) => ({ command: parseCommand(content) }));
  try {
    handler.handle(frame("failed", "#codex 修改：不用置灰"));
    for (let count = 0; count < 100 && !calls.some(text => text.includes("读取失败")); count++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.match(calls.at(-1)!, /图片读取失败.*下载或解密.*未提交任务/);
    assert.doesNotMatch(calls.at(-1)!, /secret|must not route/);
  } finally { handler.stop(); }
});

test("job bridge persists image attachments independently of the message temporary directory", async () => {
  const session = store.getSession(options.botId, "bridge", "alice", options.projectId);
  const temporary = "12345678-1234-1234-1234-123456789abc";
  const attachments = saveImageBuffers(temporary, [{ name: "screenshot.png", mime: "image/png", buffer: png }]);
  let jobId = "";
  await assert.rejects(dispatchCommand(session, { action: "plan", text: "复制合同这个不用置灰", agentProvider: "codex" }, "image-bridge", options,
    id => { jobId = id; throw new Error("stop before external execution"); }, attachments), /stop before external execution/);
  rmSync(join(directory, "uploads", temporary), { recursive: true });
  const job = getJob(jobId)!;
  assert.equal(job.agentProvider, "codex");
  assert.equal(job.requiresConfirm, true);
  assert.deepEqual(readFileSync(job.attachments![0].path), png);
});
