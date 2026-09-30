export interface ParsedCurl {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

function tokenize(input: string): string[] {
  const text = input.replace(/\\\r?\n/g, " ").replace(/\^\r?\n/g, " ");
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | "" = "";
  let active = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "^" && text[index + 1] === '"' && quote !== "'") {
      const after = text[index + 2];
      if (!quote) quote = '"';
      else if (!after || /\s/.test(after)) quote = "";
      else current += '"';
      active = true;
      index += 1;
      continue;
    }
    if (!quote && /\s/.test(char)) {
      if (active) { tokens.push(current); current = ""; active = false; }
      continue;
    }
    if (char === "'" && quote !== '"') {
      quote = quote === "'" ? "" : "'";
      active = true;
      continue;
    }
    if (char === '"' && quote !== "'") {
      quote = quote === '"' ? "" : '"';
      active = true;
      continue;
    }
    if ((char === "\\" && quote !== "'") || (char === "^" && quote !== "'")) {
      const next = text[index + 1];
      if (next && (char === "^" || !quote || /["\\$`]/.test(next))) {
        current += next;
        active = true;
        index += 1;
        continue;
      }
    }
    current += char;
    active = true;
  }
  if (quote) throw new Error("cURL 文本的引号未闭合");
  if (active) tokens.push(current);
  return tokens;
}

export function parseCurl(input: string): ParsedCurl {
  const tokens = tokenize(input.trim());
  if (!/^curl(?:\.exe)?$/i.test(tokens[0] ?? "")) throw new Error("请粘贴浏览器 Network 中复制的 cURL 命令");
  const headers: Record<string, string> = {};
  let url = "";
  let method = "";
  let body = "";
  let dataAsQuery = false;
  const take = (index: number, option: string): string => {
    if (!tokens[index + 1]) throw new Error(`${option} 缺少值`);
    return tokens[index + 1];
  };
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    const equal = token.indexOf("=");
    const option = token.startsWith("--") && equal > 0 ? token.slice(0, equal) : token;
    const inline = option !== token ? token.slice(equal + 1) : undefined;
    const value = () => inline ?? take(index++, option);
    if (option === "--url") url = value();
    else if (option === "-X" || option === "--request") method = value().toUpperCase();
    else if (option === "-H" || option === "--header") {
      const line = value();
      const separator = line.indexOf(":");
      if (separator <= 0) throw new Error("cURL 请求头格式无效");
      headers[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
    } else if (option === "-b" || option === "--cookie") headers.Cookie = value();
    else if (["-d", "--data", "--data-raw", "--data-binary", "--data-ascii", "--data-urlencode"].includes(option)) {
      const part = value();
      if (part.startsWith("@") && option === "--data-binary") throw new Error("暂不支持从本地文件导入请求体");
      body = body ? `${body}&${part}` : part;
    } else if (option === "-G" || option === "--get") dataAsQuery = true;
    else if (["--compressed", "-k", "--insecure", "-L", "--location", "-s", "--silent", "-i", "--include", "--globoff"].includes(option)) {
      continue;
    } else if (option === "-F" || option === "--form") throw new Error("暂不支持 multipart 文件上传请求");
    else if (option.startsWith("-")) throw new Error(`暂不支持 cURL 选项 ${option}`);
    else if (!url) url = token;
    else throw new Error("cURL 包含多个地址或额外命令");
  }
  let parsedUrl: URL;
  try { parsedUrl = new URL(url); }
  catch { throw new Error("cURL 中没有有效的请求地址"); }
  if (!/^https?:$/.test(parsedUrl.protocol)) throw new Error("只支持 HTTP(S) 接口地址");
  if (dataAsQuery && body) {
    parsedUrl.search += `${parsedUrl.search ? "&" : "?"}${body}`;
    body = "";
    method ||= "GET";
  }
  return { url: parsedUrl.href, method: method || (body ? "POST" : "GET"), headers, body };
}
