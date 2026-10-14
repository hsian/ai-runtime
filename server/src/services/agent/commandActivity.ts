export function commandActivity(input: unknown): string {
  let command = typeof input === "string" ? input : "";
  if (input && typeof input === "object") {
    const record = input as Record<string, unknown>;
    const value = record.command ?? record.cmd;
    command = typeof value === "string" ? value : Array.isArray(value) ? value.join(" ") : "";
  }
  if (/api-doc-query\.cjs/i.test(command)) return "查询接口字段文档";
  if (/\b(npm|pnpm|yarn|bun)\s+(install|ci|add)\b|\bpip\s+install\b/i.test(command)) return "安装项目依赖";
  if (/\b(vitest|jest|pytest)\b|--test\b|\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b/i.test(command)) return "运行回归测试";
  if (/\b(tsc|eslint)\b|\b(npm|pnpm|yarn|bun)\s+(run\s+)?(build|lint|typecheck)\b/i.test(command)) return "检查编译和代码规范";
  if (/\bgit\s+(diff|status|show)\b/i.test(command)) return "检查代码变更";
  if (/\b(rg|grep|Get-Content|Select-String|sed|cat)\b/i.test(command)) return "查阅和定位代码";
  return "执行项目命令";
}
