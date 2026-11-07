// Lays out the files of a GitHub/GitLab release in srcipts/release/ from an already built tree
// (it runs `npm run build:all` first; --no-build packs what is already in target/release):
//
//   nihao-installer-<os>-<arch>[.exe]          the installer people download for a first install
//   nihao-launcher-<os>-<arch>-<version>.zip   the self-update payload (the installer reads it too)
//   nihao-launcher-<os>-<arch>-<version>.zip.sig   its release signature (srcipts/release-sign.mjs)
//
// The version is in the zip's name because the installer, when the zip lies next to it, needs it to
// check the signature. Attach all three to the release on both hosts (DOCUMENTATION/general/signing.md).
//
//   node srcipts/release-pack.mjs [--no-build] [v0.2.0]     the tag, if given, must equal the version in the files
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkVersions } from "./check-version.mjs";
import { signZip } from "./release-sign.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const here = dirname(fileURLToPath(import.meta.url));

// shortcut: Windows only; add a row (and a zip tool that keeps the executable bit) when another OS ships.
const platforms = { win32: { os: "windows", exe: ".exe" } };
const platform = platforms[process.platform];
if (!platform) throw new Error(`release-pack supports only Windows for now, not ${process.platform}`);
const { os, exe } = platform;
const suffix = `${os}-${process.arch}`;

const args = process.argv.slice(2);
if (!args.includes("--no-build")) {
  const { status } = spawnSync(process.execPath, [join(here, "build-all.mjs")], { cwd: root, stdio: "inherit" });
  if (status !== 0) throw new Error("build-all failed");
}
const version = checkVersions(args.find((a) => !a.startsWith("--")));

const built = join(root, "target", "release");
const installer = join(root, "Installer", "target", "release", `nihao-installer${exe}`);
const programs = existsSync(built) ? readdirSync(built).filter((f) => extname(f) === exe) : [];
// The installer starts the first executable in the zip root, so there must be exactly one.
if (programs.length !== 1) throw new Error(`Expected one ${exe} in ${built}, found ${programs.length}. Run: npm run build:all`);
for (const needed of [installer, ...["plugins", "themes", "lang"].map((d) => join(built, d))]) {
  if (!existsSync(needed)) throw new Error(`${needed} is missing. Run: npm run build:all`);
}

const out = join(here, "release");
mkdirSync(out, { recursive: true });
const zip = join(out, `nihao-launcher-${suffix}-${version}.zip`);
const setup = join(out, `nihao-installer-${suffix}${exe}`);

// System32's tar is bsdtar, which writes zip; a `tar` on PATH may be GNU tar (Git Bash), which cannot.
const tar = join(process.env.SystemRoot ?? "C:\Windows", "System32", "tar.exe");
const entries = [...programs, "plugins", "themes", "lang"]; // named one by one: `.` would prefix every entry with ./
const packed = spawnSync(tar, ["-a", "-c", "-f", zip, "-C", built, ...entries], { stdio: "inherit" });
if (packed.status !== 0) throw new Error("Packing the zip failed");
const listing = spawnSync(tar, ["-t", "-f", zip], { encoding: "utf8" }).stdout.split(/\r?\n/);
if (!listing.includes(programs[0])) throw new Error(`${programs[0]} is not at the root of ${zip}`);

copyFileSync(installer, setup);
signZip(zip);

console.log(`\nRelease ${version} is in ${out}:\n  ${[setup, zip, `${zip}.sig`].map((f) => f.slice(out.length + 1)).join("\n  ")}`);
