import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("..", import.meta.url));

async function javascriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? javascriptFiles(target) : entry.name.endsWith(".js") ? [target] : [];
  }));
  return files.flat().sort();
}

const files = (await Promise.all(["src", "scripts", "test"].map((name) => javascriptFiles(path.join(root, name))))).flat();
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`Syntax checked ${files.length} JavaScript files.`);
