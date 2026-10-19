/** Backend and backend data-team task names share dependencies and completion notices. */
export function isBackendTaskName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.startsWith("后端") || /^数据\s*-/.test(trimmed);
}
