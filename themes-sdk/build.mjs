// Builds the themes in themes-sdk/themes/ into themes-sdk/dist/<id>/ (theme.js + theme.json).
//
//   node themes-sdk/build.mjs                       build every theme
//   node themes-sdk/build.mjs console               build one
//   node themes-sdk/build.mjs --install target/debug   ...and copy them into <dir>/themes/
//                                                    (next to the launcher's exe, where it looks)
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const installAt = args.includes("--install") ? args[args.indexOf("--install") + 1] : null;
const wanted = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--install");

const all = readdirSync(join(here, "themes"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
const ids = wanted.length ? wanted : all;

for (const id of ids) {
  if (!all.includes(id)) throw new Error(`No such theme: ${id} (have: ${all.join(", ")})`);
  console.log(`\n== building theme "${id}"`);
  execFileSync(process.execPath, [join(here, "..", "node_modules", "vite", "bin", "vite.js"), "build", "--config", join(here, "vite.config.ts")], {
    stdio: "inherit",
    env: { ...process.env, THEME: id },
  });
  const src = join(here, "themes", id);
  const out = join(here, "dist", id);
  cpSync(join(src, "theme.json"), join(out, "theme.json"));
  const { icon } = JSON.parse(readFileSync(join(src, "theme.json"), "utf8"));
  if (icon) cpSync(join(src, icon), join(out, icon));
  if (existsSync(join(src, "assets"))) cpSync(join(src, "assets"), join(out, "assets"), { recursive: true });
  if (installAt) {
    const dest = resolve(here, "..", installAt, "themes", id);
    mkdirSync(dest, { recursive: true });
    cpSync(join(here, "dist", id), dest, { recursive: true });
    console.log(`   installed to ${dest}`);
  }
}
if (!existsSync(join(here, "dist"))) process.exit(1);
