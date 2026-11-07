//! Files a modpack needs that the player has to download by hand (`MinecraftProfile::missing_files`,
//! see `services::BlockedFile`). `check` looks for them where the player would have put them: in the
//! instance itself or in the Downloads folder, from which a file with the right contents is copied
//! in. `delete_copies` then cleans those copies out of Downloads.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::modpack_format::hash_file_sha1;
use super::modpack_format::safe_join;
use super::services::BlockedFile;

/// A file `check` took from the Downloads folder and put into the instance.
#[derive(Serialize, Deserialize, Clone)]
pub struct DownloadedCopy {
    /// Its name in Downloads (a browser may have renamed it: `a (1).jar`).
    pub file: String,
    /// Where it went, relative to the instance.
    pub path: String,
}

#[derive(Serialize)]
pub struct CheckResult {
    /// Still not there.
    pub missing: Vec<BlockedFile>,
    pub copied: Vec<DownloadedCopy>,
    /// Names of files in Downloads that look right but have other contents (another build).
    pub wrong_build: Vec<String>,
}

/// `candidate` is `file_name` or how a browser names a repeated download of it (`a (1).jar`).
fn is_download_of(candidate: &str, file_name: &str) -> bool {
    if candidate == file_name {
        return true;
    }
    let path = Path::new(file_name);
    let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else { return false };
    let ext = path.extension().and_then(|e| e.to_str()).map(|e| format!(".{e}")).unwrap_or_default();
    candidate
        .strip_prefix(stem)
        .and_then(|rest| rest.strip_suffix(ext.as_str()))
        .and_then(|number| number.strip_prefix(" (")?.strip_suffix(')'))
        .is_some_and(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

/// Splits `missing` into what is now in place and what still isn't. A file already in the instance
/// counts as found; otherwise the newest file in `downloads` with its name (and, when the pack's
/// SHA-1 is known, its contents) is copied in.
pub fn check(instance_dir: &Path, downloads: Option<&Path>, missing: Vec<BlockedFile>) -> CheckResult {
    let listing: Vec<(String, PathBuf)> = downloads
        .and_then(|d| std::fs::read_dir(d).ok())
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .filter_map(|e| Some((e.file_name().to_str()?.to_string(), e.path())))
        .collect();

    let mut result = CheckResult { missing: Vec::new(), copied: Vec::new(), wrong_build: Vec::new() };
    for file in missing {
        let Ok(dest) = safe_join(instance_dir, &file.path) else {
            result.missing.push(file);
            continue;
        };
        if dest.exists() {
            continue;
        }

        let wanted = Path::new(&file.path).file_name().and_then(|n| n.to_str()).unwrap_or_default();
        let mut candidates: Vec<&(String, PathBuf)> = listing.iter().filter(|(name, _)| is_download_of(name, wanted)).collect();
        candidates.sort_by_key(|(_, path)| std::cmp::Reverse(std::fs::metadata(path).and_then(|m| m.modified()).ok()));

        let mut found = false;
        for (name, path) in candidates {
            let right = file.sha1.is_empty() || hash_file_sha1(path).is_ok_and(|(sha1, _)| sha1.eq_ignore_ascii_case(&file.sha1));
            if !right {
                result.wrong_build.push(name.clone());
                continue;
            }
            // Copied under a temporary name, so an interrupted copy is never taken for the file.
            let mut part = dest.clone().into_os_string();
            part.push(".part");
            let copied = dest
                .parent()
                .map_or(Ok(()), std::fs::create_dir_all)
                .and_then(|_| std::fs::copy(path, &part))
                .and_then(|_| std::fs::rename(&part, &dest));
            if copied.is_ok() {
                result.copied.push(DownloadedCopy { file: name.clone(), path: file.path.clone() });
                found = true;
                break;
            }
        }
        if !found {
            result.missing.push(file);
        }
    }
    result
}

/// Deletes from `downloads` the files `check` copied, and returns how many it deleted. Only a bare
/// file name that is still byte for byte what is in the instance goes, whatever it is asked to
/// delete, so nothing the player doesn't have elsewhere is ever lost.
pub fn delete_copies(instance_dir: &Path, downloads: &Path, copies: &[DownloadedCopy]) -> usize {
    let mut deleted = 0;
    for copy in copies {
        let bare_name = Path::new(&copy.file).file_name().is_some_and(|n| n == copy.file.as_str());
        let Ok(in_instance) = safe_join(instance_dir, &copy.path) else { continue };
        let in_downloads = downloads.join(&copy.file);
        let same = matches!((hash_file_sha1(&in_instance), hash_file_sha1(&in_downloads)), (Ok(a), Ok(b)) if a.0 == b.0);
        if bare_name && same && std::fs::remove_file(&in_downloads).is_ok() {
            deleted += 1;
        }
    }
    deleted
}

#[cfg(test)]
mod tests {
    use super::*;

    fn missing(path: &str, content: &[u8]) -> BlockedFile {
        use sha1::{Digest, Sha1};
        BlockedFile { path: path.to_string(), sha1: format!("{:x}", Sha1::digest(content)), name: "A mod".to_string(), page_url: String::new() }
    }

    fn temp(tag: &str) -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!("nihao-missing-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let (instance, downloads) = (root.join("instance"), root.join("downloads"));
        std::fs::create_dir_all(&instance).unwrap();
        std::fs::create_dir_all(&downloads).unwrap();
        (instance, downloads)
    }

    #[test]
    fn browser_renamed_downloads_are_recognised() {
        assert!(is_download_of("a.jar", "a.jar"));
        assert!(is_download_of("a (1).jar", "a.jar"));
        assert!(is_download_of("a (12).jar", "a.jar"));
        assert!(!is_download_of("a (x).jar", "a.jar"));
        assert!(!is_download_of("a () .jar", "a.jar"));
        assert!(!is_download_of("ab.jar", "a.jar"));
        assert!(!is_download_of("a (1).zip", "a.jar"));
    }

    #[test]
    fn check_finds_files_in_the_instance_and_in_downloads() {
        let (instance, downloads) = temp("check");
        std::fs::create_dir_all(instance.join("mods")).unwrap();
        std::fs::write(instance.join("mods/placed.jar"), b"placed").unwrap();
        std::fs::write(downloads.join("fresh.jar"), b"fresh").unwrap();
        std::fs::write(downloads.join("renamed (1).jar"), b"renamed").unwrap();
        std::fs::write(downloads.join("other.jar"), b"not the build the pack wants").unwrap();

        let result = check(
            &instance,
            Some(&downloads),
            vec![
                missing("mods/placed.jar", b"placed"),
                missing("mods/fresh.jar", b"fresh"),
                missing("mods/renamed.jar", b"renamed"),
                missing("mods/other.jar", b"the build the pack wants"),
                missing("mods/absent.jar", b"absent"),
            ],
        );

        assert_eq!(result.missing.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(), ["mods/other.jar", "mods/absent.jar"]);
        assert_eq!(result.wrong_build, ["other.jar"]);
        assert_eq!(result.copied.iter().map(|c| (c.file.as_str(), c.path.as_str())).collect::<Vec<_>>(), [("fresh.jar", "mods/fresh.jar"), ("renamed (1).jar", "mods/renamed.jar")]);
        assert_eq!(std::fs::read(instance.join("mods/fresh.jar")).unwrap(), b"fresh");
        assert!(!instance.join("mods/fresh.jar.part").exists());
        // The Downloads folder is left alone by a check.
        assert!(downloads.join("fresh.jar").exists());
        let _ = std::fs::remove_dir_all(instance.parent().unwrap());
    }

    #[test]
    fn only_identical_copies_are_deleted_from_downloads() {
        let (instance, downloads) = temp("delete");
        std::fs::create_dir_all(instance.join("mods")).unwrap();
        std::fs::write(instance.join("mods/same.jar"), b"same").unwrap();
        std::fs::write(downloads.join("same.jar"), b"same").unwrap();
        std::fs::write(instance.join("mods/changed.jar"), b"edited since").unwrap();
        std::fs::write(downloads.join("changed.jar"), b"as downloaded").unwrap();
        std::fs::write(downloads.join("unrelated.jar"), b"not ours").unwrap();

        let copy = |file: &str, path: &str| DownloadedCopy { file: file.to_string(), path: path.to_string() };
        let deleted = delete_copies(
            &instance,
            &downloads,
            &[copy("same.jar", "mods/same.jar"), copy("changed.jar", "mods/changed.jar"), copy("../instance/mods/same.jar", "mods/same.jar"), copy("unrelated.jar", "mods/nope.jar")],
        );

        assert_eq!(deleted, 1);
        assert!(!downloads.join("same.jar").exists());
        assert!(downloads.join("changed.jar").exists() && downloads.join("unrelated.jar").exists());
        assert!(instance.join("mods/same.jar").exists());
        let _ = std::fs::remove_dir_all(instance.parent().unwrap());
    }
}
