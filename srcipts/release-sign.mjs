// Signs and checks the zip of a release. The launcher's self-update and the installer refuse a zip
// whose signature does not check out against keys/update.pub (shared/release_sig.rs).
//
//   node srcipts/release-sign.mjs keygen [private-key.pem]   one-time: makes the key pair
//   node srcipts/release-sign.mjs sign   <release.zip>       writes <release.zip>.sig next to it
//   node srcipts/release-sign.mjs verify <release.zip>       checks <release.zip>.sig the way the launcher will
//
// The private key is read from the file named by NIHAO_UPDATE_KEY (default ~/.nihao/update-signing.pem), or
// from the text in NIHAO_UPDATE_KEY_PEM (for a CI secret). `sign` signs the version in src-tauri/Cargo.toml, so a zip
// built from a tree whose version was not raised does not match the release tag and is refused.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_KEY_FILE = join(homedir(), ".nihao", "update-signing.pem");
const PUBLIC_KEY_FILE = join(root, "keys", "update.pub");
// DER prefix of an Ed25519 public key (SPKI); the 32 raw key bytes follow.
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Must stay the same as `message` in shared/release_sig.rs. */
export function message(version, sha256Hex) {
  return Buffer.from(`nihao-release-v1\n${version}\n${sha256Hex}\n`);
}

export function cargoVersion() {
  const text = readFileSync(join(root, "src-tauri", "Cargo.toml"), "utf8");
  const match = text.match(/^version\s*=\s*"([^"]+)"/m);
  if (!match) throw new Error("no version in src-tauri/Cargo.toml");
  return match[1];
}

const sha256Hex = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

function privateKey() {
  const file = process.env.NIHAO_UPDATE_KEY ?? DEFAULT_KEY_FILE;
  const pem = process.env.NIHAO_UPDATE_KEY_PEM ?? (existsSync(file) ? readFileSync(file, "utf8") : null);
  if (!pem) throw new Error(`No private key: set NIHAO_UPDATE_KEY (path) or NIHAO_UPDATE_KEY_PEM (text), or put it at ${DEFAULT_KEY_FILE}.`);
  return createPrivateKey(pem);
}

function publicKey() {
  const raw = Buffer.from(readFileSync(PUBLIC_KEY_FILE, "utf8").trim(), "hex");
  if (raw.length !== 32) throw new Error(`${PUBLIC_KEY_FILE} must hold 64 hex digits`);
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" });
}

function keygen(out = DEFAULT_KEY_FILE) {
  if (existsSync(out) || existsSync(PUBLIC_KEY_FILE)) {
    throw new Error(`Refusing to replace an existing key (${out} / ${PUBLIC_KEY_FILE}). Delete them first if you really want a new pair: every launcher already out would stop accepting your updates.`);
  }
  const { publicKey: pub, privateKey: priv } = generateKeyPairSync("ed25519");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, priv.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  mkdirSync(dirname(PUBLIC_KEY_FILE), { recursive: true });
  writeFileSync(PUBLIC_KEY_FILE, pub.export({ format: "der", type: "spki" }).subarray(SPKI_PREFIX.length).toString("hex") + "\n");
  console.log(`Private key: ${out}   (secret: back it up, never commit it, put its text in CI as NIHAO_UPDATE_KEY_PEM)`);
  console.log(`Public key:  ${PUBLIC_KEY_FILE}   (commit it; it is compiled into the launcher and the installer)`);
}

export function signZip(zip) {
  const version = cargoVersion();
  const signature = sign(null, message(version, sha256Hex(zip)), privateKey());
  writeFileSync(`${zip}.sig`, signature.toString("hex") + "\n");
  console.log(`Signed ${zip} as version ${version}: ${zip}.sig`);
  checkZip(zip, version);
}

function checkZip(zip, version = cargoVersion()) {
  const signature = Buffer.from(readFileSync(`${zip}.sig`, "utf8").trim(), "hex");
  if (!verify(null, message(version, sha256Hex(zip)), publicKey(), signature)) {
    throw new Error(`${zip}.sig does not match ${zip} for version ${version}`);
  }
  console.log(`OK: ${zip}.sig is valid for version ${version}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, arg] = process.argv.slice(2);
  try {
    if (command === "keygen") keygen(arg);
    else if (command === "sign" && arg) signZip(arg);
    else if (command === "verify" && arg) checkZip(arg);
    else throw new Error("Usage: node srcipts/release-sign.mjs keygen [private-key.pem] | sign <zip> | verify <zip>");
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
