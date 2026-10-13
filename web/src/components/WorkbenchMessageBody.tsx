import type { ReactNode } from "react";

function inline(text: string): ReactNode {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g).map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={index}>{part.slice(1, -1)}</code>;
    const link = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(part);
    if (link) return <a key={index} href={link[2]} target="_blank" rel="noreferrer">{link[1]}</a>;
    return part;
  });
}

/** Render a small, safe Markdown subset; raw HTML remains ordinary text. */
export function WorkbenchMessageBody({ text }: { text: string }) {
  return <div className="wb-chat-message-body">{text.split(/^```[^\n]*\n/m).map((section, index) => {
    if (index % 2) {
      const end = section.indexOf("```");
      return <pre key={index}><code>{end >= 0 ? section.slice(0, end).trimEnd() : section}</code></pre>;
    }
    return section.split(/\n\s*\n/).map((paragraph, part) => {
      const lines = paragraph.split("\n");
      const heading = /^(#{1,4})\s+(.+)$/.exec(paragraph);
      if (heading) return <h3 key={`${index}-${part}`}>{inline(heading[2])}</h3>;
      if (lines.every(line => /^\s*[-*]\s+/.test(line))) return <ul key={`${index}-${part}`}>{lines.map((line, row) => <li key={row}>{inline(line.replace(/^\s*[-*]\s+/, ""))}</li>)}</ul>;
      if (lines.every(line => /^\s*\d+[.)]\s+/.test(line))) return <ol key={`${index}-${part}`}>{lines.map((line, row) => <li key={row}>{inline(line.replace(/^\s*\d+[.)]\s+/, ""))}</li>)}</ol>;
      return <p key={`${index}-${part}`}>{inline(paragraph)}</p>;
    });
  })}</div>;
}
