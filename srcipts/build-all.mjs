// Builds everything into target/release: the launcher, every module (plugins/) and every theme (themes/),
// and the installer into Installer/target/release. On Windows the programs are signed when a
// certificate is configured (srcipts/sign.mjs, DOCUMENTATION/general/signing.md).
// Same script on Windows, Linux and macOS (Node is already required for the UI):
//
//   node srcipts/build-all.mjs
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkVersions } from "./check-version.mjs";
import { signFiles } from "./sign.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const win = process.platform === "win32";
// What a Rust cdylib is called on this OS; the launcher looks for `<name>.<ext>` in plugins/.
const libExt = { win32: ".dll", darwin: ".dylib" }[process.platform] ?? ".so";

function run(cmd, args, cwd = root) {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  // npm is `npm.cmd` on Windows, which only starts through a shell. Nothing else needs one, and a
  // shell would split node's own path ("C:\Program Files\...") at the space.
  const { status } = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: win && cmd === "npm" });
  if (status !== 0) throw new Error(`Failed: ${cmd} ${args.join(" ")}`);
}

console.log(`== Version ${checkVersions()}`);

console.log("== Launcher UI");
run("npm", ["install"]);
run("npm", ["run", "build"]);

console.log("== Module UIs");
const gamesDir = join(root, "plugin-sources", "games");
for (const game of readdirSync(gamesDir, { withFileTypes: true }).filter((d) => d.isDirectory())) {
  const ui = join(gamesDir, game.name, "ui");
  try {
    readdirSync(ui);
  } catch {
    continue; // a module without a UI
  }
  run("npm", ["install"], ui);
  run("npm", ["run", "build"], ui);
}

console.log("== Launcher + modules (Rust)");
// custom-protocol = serve the built UI from the exe instead of the dev server (what `cargo tauri build` sets).
run("cargo", ["build", "--release", "-p", "nihao-client", "--features", "tauri/custom-protocol"]);
run("cargo", ["build", "--release", "--workspace", "--exclude", "nihao-client"]);

console.log("== Copy modules");
const release = join(root, "target", "release");
const plugins = join(release, "plugins");
mkdirSync(plugins, { recursive: true });
for (const file of readdirSync(release).filter((f) => extname(f) === libExt)) {
  // Unix cdylibs are named `libminecraft.so`; the launcher wants `minecraft.so`.
  const name = win ? file : file.replace(/^lib/, "");
  copyFileSync(join(release, file), join(plugins, name));
  console.log(`Copied: ${name}`);
}

console.log("== Sign");
signFiles(win ? [...readdirSync(release).filter((f) => extname(f) === ".exe").map((f) => join(release, f)), ...readdirSync(plugins).map((f) => join(plugins, f))] : []);

console.log("== Themes");
run(process.execPath, [join("themes-sdk", "build.mjs"), "--install", join("target", "release")]);

console.log("== Installer");
run("cargo", ["build", "--release", "--manifest-path", join("Installer", "Cargo.toml")]);
signFiles(win ? [join(root, "Installer", "target", "release", "nihao-installer.exe")] : []);

console.log("\nDone: target/release and Installer/target/release");
