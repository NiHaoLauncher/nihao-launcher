use std::path::{Path, PathBuf};
use std::{env, fs};

fn main() {
    embed_build_key();
    deploy_translations();
    tauri_build::build()
}

/// Copies the translations next to the launcher's executable, where it reads them:
/// `lang/*.json` of the repository to `<target>/<profile>/lang/`, and each module's
/// `plugin-sources/games/<id>/lang/*.json` to `<target>/<profile>/lang/<id>/`. Done by every build, so
/// a fresh clone starts with `cargo tauri dev` and a release build has its translations without a
/// separate step. The repository's files are the originals: edit them, not the copies.
fn deploy_translations() {
    let Ok(manifest_dir) = env::var("CARGO_MANIFEST_DIR") else { return };
    let Ok(out_dir) = env::var("OUT_DIR") else { return };
    let root = Path::new(&manifest_dir).join("..");
    // OUT_DIR is <target>/<profile>/build/<crate>-<hash>/out
    let Some(profile_dir) = PathBuf::from(out_dir).ancestors().nth(3).map(Path::to_path_buf) else { return };
    let dest = profile_dir.join("lang");

    copy_json(&root.join("lang"), &dest);
    for game in fs::read_dir(root.join("plugin-sources").join("games")).into_iter().flatten().flatten() {
        if game.path().is_dir() {
            copy_json(&game.path().join("lang"), &dest.join(game.file_name()));
        }
    }
}

fn copy_json(from: &Path, to: &Path) {
    let Ok(entries) = fs::read_dir(from) else { return };
    println!("cargo:rerun-if-changed={}", from.display());
    let _ = fs::create_dir_all(to);
    for entry in entries.flatten() {
        if entry.path().extension().is_some_and(|e| e == "json") {
            let _ = fs::copy(entry.path(), to.join(entry.file_name()));
        }
    }
}

/// Bakes the client-proof key (DOCUMENTATION/server/security.md) into the executable. It comes from
/// the environment or the git-ignored `.env` at the repository root, never from a tracked file, so
/// it stays out of GitHub/GitLab. A release build without it fails: it could never sign in.
fn embed_build_key() {
    let env_file = Path::new(&env::var("CARGO_MANIFEST_DIR").unwrap_or_default()).join("..").join(".env");
    println!("cargo:rerun-if-changed={}", env_file.display());
    println!("cargo:rerun-if-env-changed=NIHAO_BUILD_KEY");
    println!("cargo:rerun-if-env-changed=NIHAO_BUILD_KEY_ID");
    let _ = dotenvy::from_path(&env_file);

    let release = env::var("PROFILE").is_ok_and(|p| p == "release");
    let key = env::var("NIHAO_BUILD_KEY").ok().filter(|k| !k.is_empty());
    let id = env::var("NIHAO_BUILD_KEY_ID").ok().filter(|k| !k.is_empty()).or_else(|| (!release).then(|| "dev".to_string()));
    match (id, key) {
        (Some(id), Some(key)) => {
            println!("cargo:rustc-env=NIHAO_BUILD_KEY_ID={id}");
            println!("cargo:rustc-env=NIHAO_BUILD_KEY={key}");
        }
        _ if release => panic!("NIHAO_BUILD_KEY and NIHAO_BUILD_KEY_ID must be set (environment or .env) for a release build"),
        _ => println!("cargo:warning=NIHAO_BUILD_KEY not set (see .env.example): the launcher cannot sign in to the server"),
    }
}
