// The launcher's version is written in three files, and the self-update compares the one in
// src-tauri/Cargo.toml with the release tag. If they drift apart a release offers itself again at
// every start (Cargo.toml too low) or never gets offered (too high). This fails when they differ,
// and with a tag argument also when the tag is not that version.
//
//   node scripts/check-version.mjs            the three files agree
//   node scripts/check-version.mjs v0.2.0     ... and the release tag is that version
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(join(root, file), "utf8");

export function versions() {
  return {
    "src-tauri/Cargo.toml": read("src-tauri/Cargo.toml").match(/^version\s*=\s*"([^"]+)"/m)?.[1],
    "src-tauri/tauri.conf.json": JSON.parse(read("src-tauri/tauri.conf.json")).package?.version,
    "package.json": JSON.parse(read("package.json")).version,
  };
}

export function checkVersions(tag) {
  const found = versions();
  const distinct = new Set(Object.values(found));
  if (distinct.size !== 1 || distinct.has(undefined)) {
    throw new Error(`The version differs between files: ${JSON.stringify(found)}`);
  }
  const [version] = distinct;
  if (tag && tag.replace(/^v/, "") !== version) {
    throw new Error(`The release tag ${tag} is not the version in the files (${version}): raise the version first.`);
  }
  return version;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(`Version ${checkVersions(process.argv[2])}: ok`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
