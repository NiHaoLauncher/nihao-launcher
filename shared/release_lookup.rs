//! Choosing a release's files, shared by the launcher's self-update and the installer so the two
//! cannot disagree about which version is newer or which zip is theirs (`#[path]`-included by both).

/// The name the OS goes by in a release asset's file name.
pub const THIS_OS: &str = if cfg!(windows) {
    "windows"
} else if cfg!(target_os = "macos") {
    "macos"
} else {
    "linux"
};

/// "v1.2.3" / "1.2.3-beta" -> [1, 2, 3]; non-numeric parts count as 0. Trailing zeros are dropped,
/// so "1.2" and "1.2.0" compare equal.
pub fn parse_version(v: &str) -> Vec<u64> {
    let mut parts: Vec<u64> = v
        .trim_start_matches('v')
        .split('-')
        .next()
        .unwrap_or("")
        .split('.')
        .map(|p| p.parse().unwrap_or(0))
        .collect();
    while parts.last() == Some(&0) {
        parts.pop();
    }
    parts
}

/// Newest version first. Stable: equal versions keep their order (so GitHub, listed first, wins a tie).
pub fn newest_first<T>(items: &mut [T], version: impl Fn(&T) -> &str) {
    items.sort_by(|a, b| parse_version(version(b)).cmp(&parse_version(version(a))));
}

/// Which OS a file is meant for, judged by the words in its name ("nihao-windows-x64.zip" -> windows).
pub fn os_of(name: &str) -> Option<&'static str> {
    name.to_lowercase().split(|c: char| !c.is_alphanumeric()).find_map(|word| match word {
        "windows" | "win" | "win32" | "win64" => Some("windows"),
        "linux" => Some("linux"),
        "macos" | "mac" | "osx" | "darwin" => Some("macos"),
        _ => None,
    })
}

/// The download URL of the `.zip` for `os` among `(file name, url)` pairs, with the URL of the
/// `<zip name>.sig` next to it if there is one. A zip whose name mentions no OS at all counts as
/// meant for every OS.
pub fn pick_zip<'a>(os: &str, assets: &[(&'a str, &'a str)]) -> Option<(&'a str, Option<&'a str>)> {
    let zips: Vec<(&str, &str)> = assets.iter().copied().filter(|(name, url)| name.ends_with(".zip") || url.ends_with(".zip")).collect();
    let target = |z: &&(&str, &str)| os_of(z.0).or_else(|| os_of(z.1));
    let (name, url) = *zips.iter().find(|z| target(z) == Some(os)).or_else(|| zips.iter().find(|z| target(z).is_none()))?;
    let signature_name = format!("{name}.sig");
    Some((url, assets.iter().find(|(n, _)| *n == signature_name).map(|(_, u)| *u)))
}

#[cfg(test)]
mod release_lookup_tests {
    use super::*;

    #[test]
    fn version_ordering() {
        assert!(parse_version("v0.10.0") > parse_version("0.9.9"));
        assert!(parse_version("0.1.1") > parse_version("0.1.0"));
        assert!(parse_version("0.1.0-beta") == parse_version("0.1.0"));
        assert!(parse_version("1.2") == parse_version("1.2.0"));
    }

    #[test]
    fn the_newest_goes_first_and_a_tie_keeps_its_order() {
        let mut found = [("GitHub", "0.2.0"), ("GitLab", "0.3.0"), ("Mirror", "0.3.0")];
        newest_first(&mut found, |f| f.1);
        assert_eq!(found.map(|f| f.0), ["GitLab", "Mirror", "GitHub"]);
    }

    #[test]
    fn picks_the_zip_for_this_os() {
        let assets = [
            ("notes.txt", "https://x/notes.txt"),
            ("nihao-linux-x64.zip", "https://x/linux.zip"),
            ("nihao-windows-x64.zip", "https://x/windows.zip"),
            ("nihao-macos-arm64.zip", "https://x/macos.zip"),
        ];
        for os in ["windows", "linux", "macos"] {
            assert_eq!(pick_zip(os, &assets), Some((format!("https://x/{os}.zip").as_str(), None)));
        }
        assert_eq!(os_of("nihao-darwin.zip"), Some("macos"));
    }

    #[test]
    fn a_zip_without_an_os_name_is_for_everyone_but_never_the_wrong_os() {
        let universal = [("nihao.zip", "https://x/nihao.zip")];
        assert_eq!(pick_zip("linux", &universal), Some(("https://x/nihao.zip", None)));
        assert_eq!(pick_zip("linux", &[("nihao-windows.zip", "https://x/w.zip")]), None);
    }

    #[test]
    fn the_signature_is_the_sig_asset_of_the_chosen_zip() {
        let assets = [
            ("nihao-linux.zip", "https://x/linux.zip"),
            ("nihao-windows.zip", "https://x/windows.zip"),
            ("nihao-windows.zip.sig", "https://x/windows.zip.sig"),
        ];
        assert_eq!(pick_zip("windows", &assets), Some(("https://x/windows.zip", Some("https://x/windows.zip.sig"))));
        assert_eq!(pick_zip("linux", &assets), Some(("https://x/linux.zip", None)), "another zip's signature is not this one's");
    }
}
