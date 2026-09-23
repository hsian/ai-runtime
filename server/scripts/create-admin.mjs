import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const base = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { config } = await import("../dist/config.js");
const { createUser } = await import("../dist/services/auth.js");
const { initDatabase, closeDatabase } = await import("../dist/services/database.js");
const username = process.argv[2];
const displayName = process.argv[3];
const tapdOwnerName = process.argv[4];
if (!username || !displayName || !tapdOwnerName) {
  console.error("用法: npm run auth:create-admin -w server -- <username> <displayName> <tapdOwnerName>");
  process.exit(1);
}
process.chdir(base);
// The database is initialized by the same code as the server; never replace existing users.
initDatabase();
const db = new Database(config.DATABASE_PATH, { readonly: true });
const exists = db.prepare("SELECT COUNT(*) AS count FROM users").get().count;
db.close();
if (exists) { console.error("已有账号，请从账号管理页面创建或授权管理员"); closeDatabase(); process.exit(1); }
const password = randomBytes(18).toString("base64url");
try {
  createUser({ username, displayName, tapdOwnerName, password, role: "admin" });
  console.log(`管理员账号: ${username}\n初始密码: ${password}\n首次登录必须修改密码`);
} finally { closeDatabase(); }
