// Authenticode-signs Windows programs (.exe and .dll) with signtool, so Windows and antivirus
// programs see a named publisher instead of an anonymous download. Called by build-all.mjs for the
// launcher, its modules and the installer; also usable by hand:
//
//   node srcipts/sign.mjs target/release/nihao-laucnher.exe Installer/target/release/nihao-installer.exe
//
// A certificate is needed and is not in the repo. Set ONE of:
//   SIGN_PFX=path\to\cert.pfx  [SIGN_PFX_PASSWORD=...]   a certificate file (also a CI secret restored to a file)
//   SIGN_THUMBPRINT=<sha1>                               a certificate in the Windows store, or on a hardware token (EV)
//   SIGN_AZURE_DLIB=...\Azure.CodeSigning.Dlib.dll  SIGN_AZURE_METADATA=...\metadata.json   Azure Trusted Signing
//   SIGN_COMMAND="your-tool sign {file}"                 any other signing service; {file} is the program's path
// Optional:
//   SIGN_TIMESTAMP_URL   the timestamp server ("none" for no timestamp); default DigiCert's, or Microsoft's for Azure.
//                        Keep a timestamp: it keeps the signature valid after the certificate expires.
//   SIGNTOOL             path of signtool.exe when it is neither on PATH nor in the Windows SDK
//   SIGN_REQUIRED=1      fail instead of skipping when nothing is configured (use it for the real release)
// See DOCUMENTATION/general/signing.md for where to get a certificate.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const env = process.env;

function findSigntool() {
  if (env.SIGNTOOL) return env.SIGNTOOL;
  if (!spawnSync("signtool", ["/?"], { stdio: "ignore" }).error) return "signtool";
  const kits = "C:\\Program Files (x86)\\Windows Kits\\10\\bin";
  if (!existsSync(kits)) return null;
  const newest = (a, b) => b.localeCompare(a, undefined, { numeric: true });
  for (const version of readdirSync(kits).filter((v) => v.startsWith("10.")).sort(newest)) {
    const candidate = join(kits, version, "x64", "signtool.exe");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** The signtool arguments that pick the certificate, or null when none is configured. */
function certificateArgs() {
  if (env.SIGN_PFX) return ["/f", env.SIGN_PFX, ...(env.SIGN_PFX_PASSWORD ? ["/p", env.SIGN_PFX_PASSWORD] : [])];
  if (env.SIGN_THUMBPRINT) return ["/sha1", env.SIGN_THUMBPRINT];
  if (env.SIGN_AZURE_DLIB && env.SIGN_AZURE_METADATA) return ["/dlib", env.SIGN_AZURE_DLIB, "/dmdf", env.SIGN_AZURE_METADATA];
  return null;
}

function timestampArgs() {
  const url = env.SIGN_TIMESTAMP_URL ?? (env.SIGN_AZURE_DLIB ? "http://timestamp.acs.microsoft.com" : "http://timestamp.digicert.com");
  return url === "none" ? [] : ["/tr", url, "/td", "sha256"];
}

function skip(why) {
  if (env.SIGN_REQUIRED === "1") throw new Error(`Cannot sign: ${why}`);
  console.warn(`!! Not signed (${why}). Windows will show these programs as from an unknown publisher.`);
  return false;
}

/** Signs every file in `files`; returns whether they were signed. */
export function signFiles(files) {
  if (files.length === 0) return true;
  if (process.platform !== "win32") return skip("Authenticode signing runs on Windows");
  const custom = env.SIGN_COMMAND;
  const certificate = certificateArgs();
  if (!custom && !certificate) return skip("no certificate: set SIGN_PFX, SIGN_THUMBPRINT, SIGN_AZURE_DLIB or SIGN_COMMAND");
  const signtool = custom ? null : findSigntool();
  if (!custom && !signtool) return skip("signtool.exe not found: install the Windows SDK or set SIGNTOOL");

  for (const file of files) {
    console.log(`Signing ${file}`);
    const done = custom
      ? spawnSync(custom.replaceAll("{file}", `"${file}"`), { shell: true, stdio: "inherit" })
      : spawnSync(signtool, ["sign", "/fd", "sha256", ...timestampArgs(), "/d", "NiHao Launcher", ...certificate, file], { stdio: "inherit" });
    if (done.status !== 0) throw new Error(`Signing ${file} failed`);
    if (signtool && spawnSync(signtool, ["verify", "/pa", "/q", file]).status !== 0) {
      const why = `${file} is signed, but Windows does not trust the certificate (a self-signed or not yet trusted one)`;
      if (env.SIGN_REQUIRED === "1") throw new Error(why);
      console.warn(`!! ${why}`);
    }
  }
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    signFiles(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
