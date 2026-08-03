function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function truncateLine(text: string, maxLen: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  if (single.length <= maxLen) return single;
  return `${single.slice(0, maxLen - 3)}...`;
}

function wrapLines(text: string, maxLen: number): string {
  const lines: string[] = [];

  for (const paragraph of text.split("\n")) {
    let remaining = paragraph.trim();
    if (!remaining) continue;

    while (remaining.length > maxLen) {
      lines.push(remaining.slice(0, maxLen));
      remaining = remaining.slice(maxLen).trimStart();
    }
    if (remaining) lines.push(remaining);
  }

  return lines.join("\n");
}

export function buildCommitMessage(summary: string, jobId: string): string {
  const actualSummary = stripAnsi(summary).trim() || "完成代码修改";
  const subject = truncateLine(`feat(plugin): ${actualSummary}`, 72);
  const body = wrapLines(actualSummary, 72);
  const footer = `Job: ${jobId}`;

  return body ? `${subject}\n\n${body}\n\n${footer}` : `${subject}\n\n${footer}`;
}

export function buildMergeMessage(summary: string, jobId: string): string {
  const actualSummary = stripAnsi(summary).trim() || "完成代码修改";
  const subject = truncateLine(`merge(plugin): ${actualSummary}`, 72);
  return `${subject}\n\nJob: ${jobId}`;
}

export function formatGitError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return stripAnsi(raw).replace(/\r\n/g, "\n").trim();
}
