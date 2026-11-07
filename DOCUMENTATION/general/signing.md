# Signing

Two different signatures protect a release. They do different jobs; you need both.

| | What it proves | Who checks it | Made with |
|---|---|---|---|
| **Release signature** (`<zip>.sig`) | The zip was made by the maintainer. | The launcher's self-update and the installer, before they unpack anything. | `srcipts/release-sign.mjs` and your own key |
| **Authenticode** (inside each `.exe` / `.dll`) | The program comes from a named publisher and was not changed. | Windows (SmartScreen, the file's properties) and antivirus programs. | `srcipts/sign.mjs` and a code-signing certificate |

## Release signature

An ed25519 key pair. The public half, `keys/update.pub`, is compiled into the launcher and the
installer (`shared/release_sig.rs`). The private half signs each release zip. The signature covers the
zip's SHA-256 **and the version**, so an old signed zip cannot be served again under a newer tag.

One time (already done once on the maintainer's machine; the key is in `~/.nihao/update-signing.pem`):

```
node srcipts/release-sign.mjs keygen
```

- **Back the private key up** and keep it out of the repo (`*.pem` is git-ignored). Lose it and you
  cannot publish an update that existing launchers accept. Leak it and anyone can.
- Commit `keys/update.pub`.
- For CI, store the key's text as the secret `NIHAO_UPDATE_KEY_PEM`.
- Replacing the key means every launcher already out must be reinstalled by hand: they only accept
  the old key. `keygen` refuses to overwrite an existing pair for that reason.

For each release:

1. Raise `version` in `src-tauri/Cargo.toml` (the same number in `src-tauri/tauri.conf.json` and
   `package.json`). The tag must be that version (`v0.2.0` or `0.2.0`).
2. `npm run build:all`, then make the zip as described in [build-and-run.md](build-and-run.md).
3. Sign it. The key comes from `NIHAO_UPDATE_KEY` (a file path) or `NIHAO_UPDATE_KEY_PEM` (its text):

   ```
   set NIHAO_UPDATE_KEY=%USERPROFILE%\.nihao\update-signing.pem
   node srcipts/release-sign.mjs sign nihao-launcher-windows-x64.zip
   ```

   This writes `nihao-launcher-windows-x64.zip.sig` and checks it again with the public key. It signs
   the version found in `src-tauri/Cargo.toml`, so if you forgot step 1 the launcher will refuse the
   update (the signature will not match the tag) instead of offering it to everyone forever.
4. Upload **both** files to the release, on GitHub and on GitLab. On GitLab attach each as a release
   asset link. The `.sig` must be named exactly like the zip plus `.sig`.

A release without a `.sig` (or with one that does not match) is refused by the launcher and the
installer, which then try the other host.

## Authenticode (Windows)

`npm run build:all` signs the launcher's `.exe`, the module `.dll`s in `plugins/` and the installer
(`Installer/target/release/nihao-installer.exe`) when a certificate is configured, and warns when it
is not. The installer's copy named `uninstall.exe` is the same file, so it is signed too.

Configure ONE of these in the environment (see the top of `srcipts/sign.mjs` for all options):

| Variable | Certificate |
|---|---|
| `SIGN_PFX`, `SIGN_PFX_PASSWORD` | a `.pfx` file |
| `SIGN_THUMBPRINT` | a certificate in the Windows store, or on a hardware token |
| `SIGN_AZURE_DLIB`, `SIGN_AZURE_METADATA` | Azure Trusted Signing |
| `SIGN_COMMAND` | any other service; `{file}` stands for the program |

Set `SIGN_REQUIRED=1` for the real release so a missing certificate stops the build instead of
producing unsigned files. Keep the timestamp (the default): it keeps the signature valid after the
certificate expires.

### Where to get a certificate

A signature only helps if the certificate is one Windows trusts. A self-signed one does not (the
script says so), however convenient it is to make.

- **Azure Trusted Signing**: cheap monthly service, no hardware token, works from CI. Available to
  individuals in some countries.
- **SignPath Foundation**: free signing for open-source projects that meet its rules.
- **A code-signing certificate** (OV or EV) from a certificate authority. Since 2023 the private key
  must be on a hardware token or a cloud HSM; use `SIGN_THUMBPRINT` or the CA's tool through
  `SIGN_COMMAND`.

### Why a launcher looks suspicious to antivirus programs, and what helps

An installer that downloads a zip, unpacks programs, writes to the registry and starts one of them is
exactly what malware droppers do, so heuristic scanners flag unsigned ones. What helps, roughly in
order of effect:

1. **Sign everything**, the installer first. SmartScreen builds reputation per certificate, so a new
   certificate may still warn for a while; the warning fades as people download the signed file.
2. Keep the version information filled in (`Installer/build.rs` and the Tauri config do it). Do not
   pack or obfuscate the programs.
3. Always publish the same file name from the same place (the release pages), not re-uploaded copies.
4. If a scanner still flags a signed file, report it as a false positive to that vendor; most answer
   within days. Microsoft: <https://www.microsoft.com/en-us/wdsi/filesubmission>.

macOS and Linux builds are not covered here (macOS needs Apple signing and notarization).
