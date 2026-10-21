import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const htmlPath = fileURLToPath(new URL("../figma-plugin/ui.html", import.meta.url));
const html = readFileSync(htmlPath, "utf8");
const inlineScripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)]
  .filter((match) => {
    const attributes = match[1] || "";
    if (/\bsrc\s*=/i.test(attributes)) return false;
    const type = attributes.match(/\btype\s*=\s*["']?([^\s"'>]+)/i)?.[1]?.toLowerCase();
    return !type || ["text/javascript", "application/javascript", "module", "text/ecmascript", "application/ecmascript"].includes(type);
  });

if (inlineScripts.length === 0) {
  throw new Error("No inline JavaScript block was found in figma-plugin/ui.html.");
}

for (const [index, match] of inlineScripts.entries()) {
  const result = spawnSync(process.execPath, ["--check", "-"], {
    input: match[2],
    encoding: "utf8",
  });
  if (result.status !== 0) {
    process.stderr.write("Inline Figma UI script " + (index + 1) + " failed syntax validation.\n");
    process.stderr.write(result.stderr || result.stdout || "node --check failed.\n");
    process.exit(result.status || 1);
  }
}

process.stdout.write("Validated " + inlineScripts.length + " inline JavaScript block(s) in figma-plugin/ui.html.\n");
