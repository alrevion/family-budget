// Сборка статики Mini App без shell-команд: `rm -rf`/`cp` не работают в
// cmd.exe, а установка должна быть одинаковой на macOS, Linux и Windows.
import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

const root = process.cwd();
const out = join(root, "dist");

const files = ["index.html", "styles.css", "icon.svg", "_headers"];

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

for (const name of files) {
  const from = join(root, "app", name);
  const to = join(out, name);
  await mkdir(dirname(to), { recursive: true });
  await copyFile(from, to);
}

console.log(`dist: ${files.join(", ")}`);
