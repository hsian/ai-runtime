import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = resolve(__dirname, "../dist");

const moves = [
  ["src/app/app.html", "app.html"],
  ["src/settings/settings.html", "settings.html"],
  ["src/requirement/requirement.html", "requirement.html"],
];

for (const [from, to] of moves) {
  const src = resolve(dist, from);
  const dest = resolve(dist, to);
  if (existsSync(src)) {
    copyFileSync(src, dest);
  }
}

for (const htmlFile of ["app.html", "settings.html", "requirement.html"]) {
  const htmlPath = resolve(dist, htmlFile);
  if (!existsSync(htmlPath)) continue;

  const html = readFileSync(htmlPath, "utf8");
  const fixed = html
    .replace(/src="\.\.\/\.\.\//g, 'src="./')
    .replace(/href="\.\.\/\.\.\//g, 'href="./');
  writeFileSync(htmlPath, fixed);
}

const nestedSrc = resolve(dist, "src");
if (existsSync(nestedSrc)) {
  rmSync(nestedSrc, { recursive: true, force: true });
}
