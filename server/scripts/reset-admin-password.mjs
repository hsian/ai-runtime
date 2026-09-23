import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const username = process.argv[2];
if (!username || process.argv.length !== 3) {
  console.error("用法: npm run auth:reset-admin-password -w server -- <username>");
  process.exit(1);
}

const base = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { config } = await import("../dist/config.js");
const { initDatabase, closeDatabase } = await import("../dist/services/database.js");
const { hashPassword } = await import("../dist/services/auth.js");
process.chdir(base);

if (!existsSync(config.DATABASE_PATH)) {
  console.error(`数据库文件不存在：${config.DATABASE_PATH}，密码未更改`);
  process.exit(1);
}

try {
  const db = initDatabase();
  const user = db.prepare("SELECT id, role FROM users WHERE username = ?").get(username);
  if (!user || user.role !== "admin") {
    console.error("未找到该管理员账号，密码未更改");
    process.exitCode = 1;
  } else {
    const password = randomBytes(18).toString("base64url");
    db.transaction(() => {
      db.prepare("UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?")
        .run(hashPassword(password), user.id);
      db.prepare("DELETE FROM auth_sessions WHERE user_id = ?").run(user.id);
    })();
    console.log(`管理员账号: ${username}\n新初始密码: ${password}\n首次登录必须修改密码`);
  }
} finally {
  closeDatabase();
}
