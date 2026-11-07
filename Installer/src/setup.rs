//! Everything around the unpacked files: the uninstaller, shortcuts, the Windows "Apps" entry, and removing it all.
//!
//! Uninstalling is two runs of the same program, both started as `uninstall[.exe]`:
//! 1. `start` (no arguments, what Settings > Apps runs): opens the launcher with `--uninstall`, whose
//!    page asks what to keep and what to delete, and exits at once.
//! 2. `apply` (`--apply`, started by the launcher as it closes): reads the choice the launcher wrote
//!    to `uninstall-plan.json`, waits for the launcher to be gone and deletes.
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::release::Installed;

const APP_NAME: &str = "NiHao Launcher";
/// Written into every folder this installer set up; its text is the launcher's file name. The uninstaller deletes a folder only if it has it.
const MARKER: &str = ".nihao-installed";
/// The uninstaller is this very program: started under this name it uninstalls instead of installing.
pub const UNINSTALLER: &str = if cfg!(windows) { "uninstall.exe" } else { "uninstall" };
/// What the launcher's uninstall page decided, written next to the uninstaller (`src-tauri/src/uninstall.rs`).
const PLAN_FILE: &str = "uninstall-plan.json";
/// The `nihaolauncher://` links the launcher registers for itself at every start (`src-tauri/src/deeplink.rs`).
#[cfg(windows)]
const PROTOCOL_KEY: &str = r"Software\Classes\nihaolauncher";

/// How many times a failed delete is tried again, and the pause between: the launcher's web view
/// needs a few seconds after the launcher exits before it lets go of its files.
const ATTEMPTS: u32 = 8;
const RETRY_PAUSE: Duration = Duration::from_secs(1);
const LAUNCHER_EXIT_WAIT: Duration = Duration::from_secs(30);

/// Where the parts outside the install folder live. Tests point it at scratch folders.
pub struct Places {
    pub desktop: Option<PathBuf>,
    /// The start menu on Windows, the applications menu on Linux.
    pub menu: Option<PathBuf>,
    /// Name of the key under `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall` (Settings > Apps).
    pub reg_key: &'static str,
}

impl Places {
    pub fn system() -> Self {
        let (desktop, menu) = if cfg!(windows) {
            (dirs::desktop_dir(), dirs::data_dir().map(|d| d.join(r"Microsoft\Windows\Start Menu\Programs")))
        } else if cfg!(target_os = "macos") {
            (None, None) // the launcher is a loose folder, not an .app bundle: nothing to link to
        } else {
            (dirs::desktop_dir(), dirs::data_dir().map(|d| d.join("applications")))
        };
        Self { desktop, menu, reg_key: "NiHaoLauncher" }
    }
}

fn shortcut_file() -> String {
    format!("{APP_NAME}.{}", if cfg!(windows) { "lnk" } else { "desktop" })
}

/// Fails when `dir` can't safely be the install folder: uninstalling deletes the folder's contents,
/// so it must be new, empty, or one this installer already set up.
pub fn check_dir(dir: &Path) -> Result<(), String> {
    if !dir.is_absolute() {
        // A relative path would install into whatever folder the installer happened to start in.
        return Err("Enter the full path of the install folder.".into());
    }
    if !dir.exists() || dir.join(MARKER).exists() {
        return Ok(());
    }
    let empty = std::fs::read_dir(dir)
        .map(|mut entries| entries.next().is_none())
        .map_err(|e| format!("Cannot use '{}': {e}", dir.display()))?;
    if empty {
        Ok(())
    } else {
        Err("That folder is not empty. Choose a new or empty folder, because uninstalling removes what is in it.".into())
    }
}

/// Creates the install folder. Where the user may not (Program Files) Windows asks for administrator
/// permission once, and the folder is created with full control for this user only, because the
/// launcher keeps its settings and games next to its exe and updates itself there.
pub fn prepare_dir(dir: &Path) -> Result<(), String> {
    match std::fs::create_dir_all(dir) {
        Err(e) if cfg!(windows) && e.kind() == std::io::ErrorKind::PermissionDenied => create_as_admin(dir),
        result => result.map_err(|e| format!("cannot create '{}': {e}", dir.display())),
    }
}

#[cfg(windows)]
fn create_as_admin(dir: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    // The elevated process does not get our environment, so the paths are put into its command line here.
    let script = "$p = $env:NH_DIR; \
        $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; \
        $a = '/c if not exist \"' + $p + '\" mkdir \"' + $p + '\" & icacls \"' + $p + '\" /grant \"*' + $sid + ':(OI)(CI)F\"'; \
        $r = Start-Process cmd -ArgumentList $a -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $r.ExitCode";
    let status = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .env("NH_DIR", dir)
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .status();
    if status.is_ok_and(|s| s.success()) && dir.is_dir() {
        Ok(())
    } else {
        Err(format!("Administrator permission is needed to create '{}'. Allow it, or choose another folder.", dir.display()))
    }
}

#[cfg(not(windows))]
fn create_as_admin(dir: &Path) -> Result<(), String> {
    Err(format!("cannot create '{}': permission denied", dir.display()))
}

/// Finishes an install: puts the uninstaller next to the files, then adds the shortcuts and (on Windows)
/// the Settings > Apps entry.
pub fn register(installed: &Installed, desktop_shortcut: bool, places: &Places) -> Result<(), String> {
    let dir = &installed.dir;
    let me = std::env::current_exe().map_err(|e| e.to_string())?;
    let uninstaller = dir.join(UNINSTALLER);
    if me != uninstaller {
        std::fs::copy(&me, &uninstaller)
            .map_err(|e| format!("cannot write '{}': {e}", uninstaller.display()))?;
    }
    let launcher_name = installed.exe.as_ref().and_then(|e| e.file_name()).map(|n| n.to_string_lossy().into_owned());
    std::fs::write(dir.join(MARKER), launcher_name.unwrap_or_default()).map_err(|e| e.to_string())?;

    if let Some(exe) = &installed.exe {
        let desktop = places.desktop.as_ref().filter(|_| desktop_shortcut);
        for folder in places.menu.iter().chain(desktop) {
            make_shortcut(folder, exe, dir)?;
        }
    }
    #[cfg(windows)]
    windows_entry(installed, &uninstaller, places.reg_key)?;
    Ok(())
}

#[cfg(windows)]
fn make_shortcut(folder: &Path, exe: &Path, dir: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    std::fs::create_dir_all(folder).map_err(|e| e.to_string())?;
    // Paths travel in environment variables so quotes in them can't break the script.
    let status = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:NH_LINK); \
             $s.TargetPath = $env:NH_TARGET; $s.WorkingDirectory = $env:NH_DIR; $s.Save()",
        ])
        .env("NH_LINK", folder.join(shortcut_file()))
        .env("NH_TARGET", exe)
        .env("NH_DIR", dir)
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .status()
        .map_err(|e| format!("cannot create a shortcut: {e}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("cannot create the shortcut in '{}'", folder.display()))
    }
}

#[cfg(not(windows))]
fn make_shortcut(folder: &Path, exe: &Path, dir: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(folder).map_err(|e| e.to_string())?;
    // shortcut: a `"` or `$` in the install path breaks `Exec`; escape it per the desktop-entry spec if that ever matters.
    let entry = format!(
        "[Desktop Entry]\nType=Application\nName={APP_NAME}\nExec=\"{}\"\nPath={}\nTerminal=false\nCategories=Game;\n",
        exe.display(),
        dir.display()
    );
    let file = folder.join(shortcut_file());
    std::fs::write(&file, entry).map_err(|e| e.to_string())?;
    // Some desktops only show a .desktop file on the desktop when it is executable.
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())
}

#[cfg(windows)]
fn windows_entry(installed: &Installed, uninstaller: &Path, key: &str) -> Result<(), String> {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};
    let path = format!(r"Software\Microsoft\Windows\CurrentVersion\Uninstall\{key}");
    let write = || -> std::io::Result<()> {
        let (k, _) = RegKey::predef(HKEY_CURRENT_USER).create_subkey(&path)?;
        k.set_value("DisplayName", &APP_NAME)?;
        k.set_value("DisplayVersion", &installed.version)?;
        k.set_value("Publisher", &"NiHao")?;
        k.set_value("InstallLocation", &installed.dir.display().to_string())?;
        k.set_value("UninstallString", &format!("\"{}\"", uninstaller.display()))?;
        if let Some(exe) = &installed.exe {
            k.set_value("DisplayIcon", &exe.display().to_string())?;
        }
        k.set_value("NoModify", &1u32)?;
        k.set_value("NoRepair", &1u32)
    };
    write().map_err(|e| format!("cannot add the app to Settings > Apps: {e}"))
}

/// True when this program was started as the uninstaller (see `UNINSTALLER`).
pub fn is_uninstaller() -> bool {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.file_stem().map(|s| s.eq_ignore_ascii_case("uninstall")))
        .unwrap_or(false)
}

/// The folder this uninstaller sits in, after checking that the installer set it up: without its
/// marker nothing is touched.
fn own_folder() -> Result<(PathBuf, PathBuf), String> {
    let me = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = me.parent().ok_or("cannot find the install folder")?.to_path_buf();
    check_marker(&dir)?;
    Ok((me, dir))
}

fn check_marker(dir: &Path) -> Result<(), String> {
    if dir.join(MARKER).exists() {
        Ok(())
    } else {
        Err(format!("'{}' was not set up by the NiHao installer, so nothing was deleted.", dir.display()))
    }
}

fn is_program(path: &Path) -> bool {
    #[cfg(windows)]
    return path.extension().is_some_and(|e| e.eq_ignore_ascii_case("exe"));
    #[cfg(not(windows))]
    {
        use std::os::unix::fs::PermissionsExt;
        path.metadata().is_ok_and(|m| m.permissions().mode() & 0o111 != 0)
    }
}

/// The launcher's executable: named in the marker, else (an install made before the marker held the
/// name) the first program in the folder that is not the uninstaller.
fn find_launcher(dir: &Path) -> Option<PathBuf> {
    let marked = std::fs::read_to_string(dir.join(MARKER)).unwrap_or_default();
    if let Some(name) = Path::new(marked.trim()).file_name() {
        let exe = dir.join(name);
        if exe.is_file() {
            return Some(exe);
        }
    }
    std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file() && is_program(p) && p.file_name().is_some_and(|n| !n.eq_ignore_ascii_case(UNINSTALLER)))
        .min()
}

/// First step: opens the launcher on its uninstall page. `Ok(false)` when it can't be opened
/// (deleted, damaged), so the caller can offer to remove everything instead.
pub fn start() -> Result<bool, String> {
    let (_, dir) = own_folder()?;
    // A plan left by an abandoned run must not be taken for this one's.
    let _ = std::fs::remove_file(dir.join(PLAN_FILE));
    Ok(find_launcher(&dir)
        .is_some_and(|exe| std::process::Command::new(exe).arg("--uninstall").current_dir(&dir).spawn().is_ok()))
}

/// Second step: does what the launcher's page decided.
pub fn apply() -> Result<(), String> {
    #[cfg(windows)]
    if !std::env::args().any(|a| a == "--elevated") {
        return relaunch_as_admin();
    }
    let (me, dir) = own_folder()?;
    let text = std::fs::read_to_string(dir.join(PLAN_FILE)).map_err(|e| format!("there is no uninstall plan: {e}"))?;
    let plan = Plan::parse(&text)?;
    wait_until_launcher_exits(&dir);
    finish_removal(&me, &dir, &plan)
}

/// Removing the folder needs administrator rights when it is in Program Files: asks once (UAC) and starts
/// `apply` again with them. Declining deletes nothing.
#[cfg(windows)]
fn relaunch_as_admin() -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let me = std::env::current_exe().map_err(|e| e.to_string())?;
    let status = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Start-Process -FilePath $env:NH_EXE -ArgumentList '--apply','--elevated' -Verb RunAs",
        ])
        .env("NH_EXE", me)
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .status();
    if status.is_ok_and(|s| s.success()) {
        Ok(())
    } else {
        Err("Administrator permission is needed to remove the launcher, so nothing was deleted. Run the uninstaller again and allow it.".into())
    }
}

/// The fallback of `start`: everything in the folder goes.
pub fn remove_everything() -> Result<(), String> {
    let (me, dir) = own_folder()?;
    finish_removal(&me, &dir, &Plan::default())
}

fn finish_removal(me: &Path, dir: &Path, plan: &Plan) -> Result<(), String> {
    let outcome = remove_files(dir, me, plan, RETRY_PAUSE)?;
    unregister(dir, &Places::system());
    leave(dir, me, &outcome)
}

/// The launcher was told to exit just before this started; its exe can't be opened for writing until it has.
fn wait_until_launcher_exits(dir: &Path) {
    let Some(exe) = find_launcher(dir) else { return };
    let started = Instant::now();
    while started.elapsed() < LAUNCHER_EXIT_WAIT && std::fs::OpenOptions::new().write(true).open(&exe).is_err() {
        std::thread::sleep(Duration::from_millis(250));
    }
}

/// The launcher's page: what to delete wherever it is, what to leave alone, and which folders to
/// drop once empty. Empty (no file) means "everything in the install folder".
#[derive(Default, Debug)]
pub struct Plan {
    pub delete: Vec<PathBuf>,
    pub keep: Vec<PathBuf>,
    pub prune: Vec<PathBuf>,
}

impl Plan {
    pub fn parse(text: &str) -> Result<Plan, String> {
        let json: Value = serde_json::from_str(text).map_err(|e| format!("the uninstall plan is damaged: {e}"))?;
        let paths = |key: &str| -> Vec<PathBuf> {
            json[key].as_array().into_iter().flatten().filter_map(Value::as_str).map(PathBuf::from).collect()
        };
        Ok(Plan { delete: paths("delete"), keep: paths("keep"), prune: paths("prune") })
    }
}

/// What `remove_files` left behind.
pub struct Outcome {
    /// Something inside the install folder was kept, so the folder (and its marker) stays.
    pub kept_inside: bool,
}

/// `path` as it is on disk: its folder resolved, the last name left alone (a link there is the
/// thing to remove, not its target). `None` when it does not exist.
fn resolve(path: &Path) -> Option<PathBuf> {
    let full = path.parent()?.canonicalize().ok()?.join(path.file_name()?);
    full.symlink_metadata().ok().map(|_| full)
}

/// A path the plan may delete: it exists, is deep enough not to be a drive or a top folder, and is
/// neither the install folder, the user's home, nor a folder around either, nor around something to keep.
fn deletable(path: &Path, dir: &Path, keep: &[PathBuf]) -> Option<PathBuf> {
    let path = resolve(path)?;
    let depth = path.components().filter(|c| matches!(c, Component::Normal(_))).count();
    let home = dirs::home_dir().and_then(|h| h.canonicalize().ok());
    let unsafe_target = !path.is_absolute()
        || depth < 2
        || dir.starts_with(&path)
        || home.is_some_and(|h| h.starts_with(&path))
        || keep.iter().any(|k| k.starts_with(&path));
    (!unsafe_target).then_some(path)
}

fn remove_any(path: &Path) -> std::io::Result<()> {
    match path.symlink_metadata() {
        Ok(meta) if meta.is_dir() => std::fs::remove_dir_all(path),
        // A link to a folder is removed as a folder on Windows, as a file elsewhere.
        Ok(meta) if meta.file_type().is_symlink() && path.is_dir() => std::fs::remove_dir(path),
        Ok(_) => std::fs::remove_file(path),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
    }
}

/// Deletes what the plan says, then everything else in `dir` except this program (`me`), the marker
/// and what is kept. A delete that fails is tried again `ATTEMPTS` times, `pause` apart; after that
/// the failures are reported and the rest has still been done.
pub fn remove_files(dir: &Path, me: &Path, plan: &Plan, pause: Duration) -> Result<Outcome, String> {
    let dir = dir.canonicalize().map_err(|e| format!("cannot open '{}': {e}", dir.display()))?;
    let me = resolve(me).ok_or("cannot find this program")?;
    let keep: Vec<PathBuf> = plan.keep.iter().filter_map(|p| resolve(p)).collect();
    let delete: Vec<PathBuf> = plan.delete.iter().filter_map(|p| deletable(p, &dir, &keep)).collect();
    let prune: Vec<PathBuf> = plan
        .prune
        .iter()
        .filter_map(|p| resolve(p))
        .filter(|p| !dir.starts_with(p) && !keep.contains(p))
        .collect();

    let mut protected = vec![me, dir.join(MARKER)];
    protected.extend(keep.iter().filter(|k| k.starts_with(&dir)).cloned());
    let kept_inside = protected.len() > 2;

    for attempt in 1..=ATTEMPTS {
        let mut failures: Vec<(PathBuf, std::io::Error)> = Vec::new();
        for path in &delete {
            if let Err(e) = remove_any(path) {
                failures.push((path.clone(), e));
            }
        }
        for folder in &prune {
            let _ = std::fs::remove_dir(folder); // only if empty
        }
        delete_tree(&dir, &protected, &mut |path, e| failures.push((path.to_path_buf(), e)));
        if failures.is_empty() {
            return Ok(Outcome { kept_inside });
        }
        if attempt == ATTEMPTS {
            let (path, error) = &failures[0];
            return Err(format!(
                "Could not delete {} item(s), e.g. {}: {error}. Close the launcher and the game and run the uninstaller again.",
                failures.len(),
                path.display()
            ));
        }
        std::thread::sleep(pause);
    }
    unreachable!("the last attempt returns")
}

/// Deletes everything under `dir` except the paths in `keep` and the folders that lead to them,
/// reporting each item that could not go.
fn delete_tree(dir: &Path, keep: &[PathBuf], on_error: &mut impl FnMut(&Path, std::io::Error)) {
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) => return on_error(dir, e),
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if keep.contains(&path) {
            continue;
        }
        let is_dir = entry.file_type().is_ok_and(|t| t.is_dir());
        if is_dir {
            delete_tree(&path, keep, on_error);
        }
        if keep.iter().any(|k| k.starts_with(&path)) {
            continue; // something to keep lives below: this folder stays
        }
        if let Err(e) = if is_dir { std::fs::remove_dir(&path) } else { remove_any(&path) } {
            on_error(&path, e);
        }
    }
}

/// Removes the shortcuts, the Settings > Apps entry and the launcher's link handler.
fn unregister(dir: &Path, places: &Places) {
    for folder in places.desktop.iter().chain(&places.menu) {
        let _ = std::fs::remove_file(folder.join(shortcut_file()));
    }
    #[cfg(windows)]
    {
        use winreg::{enums::HKEY_CURRENT_USER, RegKey};
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let _ = hkcu.delete_subkey_all(format!(r"Software\Microsoft\Windows\CurrentVersion\Uninstall\{}", places.reg_key));
        // Only this install's handler: another copy of the launcher may have registered the link since.
        let handler: Option<String> = hkcu
            .open_subkey(format!(r"{PROTOCOL_KEY}\shell\open\command"))
            .and_then(|k| k.get_value(""))
            .ok();
        if handler.is_some_and(|h| h.to_lowercase().contains(&dir.display().to_string().to_lowercase())) {
            let _ = hkcu.delete_subkey_all(PROTOCOL_KEY);
        }
    }
    #[cfg(not(windows))]
    let _ = dir;
}

/// The last step: this program's own file goes too, and the folder with it unless something in it
/// was kept (then the marker stays, so installing there again is allowed).
fn leave(dir: &Path, me: &Path, outcome: &Outcome) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // A running .exe can't delete itself: a detached shell does it once this process has exited.
        let target = if outcome.kept_inside {
            format!("del /f /q \"{}\"", me.display())
        } else {
            format!("rmdir /s /q \"{}\"", dir.display())
        };
        std::process::Command::new("cmd")
            .current_dir(std::env::temp_dir())
            .raw_arg(format!("/C ping -n 3 127.0.0.1 >nul & {target}"))
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("cannot finish removing '{}': {e}", dir.display()))
    }
    #[cfg(not(windows))]
    {
        // unix lets a running program delete itself
        let removed = if outcome.kept_inside { std::fs::remove_file(me) } else { std::fs::remove_dir_all(dir) };
        removed.map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nihao-setup-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn file(path: &Path, content: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }

    /// An install folder as the installer leaves it, with a uninstaller file and the marker.
    fn install(root: &Path) -> (PathBuf, PathBuf) {
        let dir = root.join("app");
        let me = dir.join(UNINSTALLER);
        file(&me, "uninstaller");
        file(&dir.join("launcher.exe"), "launcher");
        file(&dir.join("lang/en.json"), "{}");
        file(&dir.join(MARKER), "launcher.exe");
        (dir, me)
    }

    fn quick(dir: &Path, me: &Path, plan: &Plan) -> Result<Outcome, String> {
        remove_files(dir, me, plan, Duration::ZERO)
    }

    #[test]
    fn only_a_new_empty_or_own_folder_is_accepted() {
        let root = scratch("check");
        assert!(check_dir(&root.join("new")).is_ok());
        assert!(check_dir(&root).is_ok(), "empty folder");
        std::fs::write(root.join("mine.txt"), "x").unwrap();
        assert!(check_dir(&root).is_err(), "someone's files would be wiped by the uninstaller");
        std::fs::write(root.join(MARKER), "").unwrap();
        assert!(check_dir(&root).is_ok(), "reinstall over our own install");
        assert!(check_dir(Path::new("relative")).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_marker_names_the_launcher_and_older_installs_are_searched() {
        let root = scratch("find");
        let (dir, _) = install(&root);
        assert_eq!(find_launcher(&dir), Some(dir.join("launcher.exe")));
        // An install from before the marker had a name: found by looking (Windows: the only .exe besides the uninstaller).
        std::fs::write(dir.join(MARKER), "").unwrap();
        assert_eq!(find_launcher(&dir), if cfg!(windows) { Some(dir.join("launcher.exe")) } else { None });
        std::fs::write(dir.join(MARKER), "../../elsewhere/launcher.exe").unwrap();
        assert_eq!(find_launcher(&dir), Some(dir.join("launcher.exe")), "a path in the marker is cut down to its file name");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_uninstaller_refuses_a_folder_the_installer_did_not_make() {
        let root = scratch("foreign");
        std::fs::write(root.join("precious.txt"), "x").unwrap();
        assert!(check_marker(&root).is_err());
        assert!(check_dir(&root).is_err());
        assert!(root.join("precious.txt").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn no_plan_empties_the_folder_but_for_the_uninstaller_and_the_marker() {
        let root = scratch("all");
        let (dir, me) = install(&root);
        let outcome = quick(&dir, &me, &Plan::default()).unwrap();
        assert!(!outcome.kept_inside);
        assert!(!dir.join("launcher.exe").exists() && !dir.join("lang").exists());
        assert!(me.exists() && dir.join(MARKER).exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn what_is_kept_inside_the_folder_survives_with_the_path_to_it() {
        let root = scratch("keep");
        let (dir, me) = install(&root);
        file(&dir.join("game/minecraft/instances/world1/saves/level.dat"), "w");
        file(&dir.join("game/minecraft/libraries/a.jar"), "a");
        file(&dir.join("game/minecraft/stray.txt"), "s");
        file(&dir.join("local.data"), "d");
        let plan = Plan {
            delete: vec![dir.join("game/minecraft/libraries"), dir.join("local.data")],
            keep: vec![dir.join("game/minecraft/instances/world1"), dir.join("game/minecraft")],
            prune: vec![],
        };
        let outcome = quick(&dir, &me, &plan).unwrap();
        assert!(outcome.kept_inside);
        assert!(dir.join("game/minecraft/instances/world1/saves/level.dat").exists());
        assert!(dir.join("game/minecraft/stray.txt").exists(), "a kept root is not swept");
        assert!(!dir.join("game/minecraft/libraries").exists() && !dir.join("local.data").exists());
        assert!(!dir.join("launcher.exe").exists() && !dir.join("lang").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn data_outside_the_folder_is_deleted_only_when_the_plan_names_it() {
        let root = scratch("outside");
        let (dir, me) = install(&root);
        file(&root.join("games/mc/instances/a/saves/x"), "x");
        file(&root.join("games/mc/instances/b/saves/y"), "y");
        file(&root.join("games/other.txt"), "mine");
        let plan = Plan {
            delete: vec![root.join("games/mc/instances/a")],
            keep: vec![],
            prune: vec![root.join("games/mc/instances"), root.join("games/mc"), root.join("games")],
        };
        quick(&dir, &me, &plan).unwrap();
        assert!(!root.join("games/mc/instances/a").exists());
        assert!(root.join("games/mc/instances/b/saves/y").exists(), "not named, so not touched");
        assert!(root.join("games/other.txt").exists());

        let plan = Plan { delete: vec![root.join("games/mc/instances/b")], keep: vec![], prune: vec![root.join("games/mc/instances"), root.join("games/mc"), root.join("games")] };
        quick(&dir, &me, &plan).unwrap();
        assert!(!root.join("games/mc").exists(), "empty folders left by the deletes are dropped");
        assert!(root.join("games/other.txt").exists(), "`games` is not empty, so it stays");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn dangerous_paths_in_a_plan_are_ignored() {
        let root = scratch("unsafe");
        let (dir, me) = install(&root);
        file(&root.join("neighbour/keep.txt"), "n");
        let drive_root = root.ancestors().last().unwrap().to_path_buf();
        let plan = Plan {
            // The install folder, the folder around it, a drive root, a relative path, a folder around a kept path.
            delete: vec![dir.clone(), root.clone(), drive_root, PathBuf::from("relative"), dir.join("lang")],
            keep: vec![dir.join("lang/en.json")],
            prune: vec![],
        };
        quick(&dir, &me, &plan).unwrap();
        assert!(root.join("neighbour/keep.txt").exists());
        assert!(dir.join("lang/en.json").exists(), "the folder around a kept path stays");
        assert!(!dir.join("launcher.exe").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_plan_file_is_read_and_a_broken_one_is_refused() {
        let plan = Plan::parse(r#"{"delete":["/a/b"],"keep":["/c/d"],"prune":[],"unknown":1}"#).unwrap();
        assert_eq!((plan.delete.len(), plan.keep.len(), plan.prune.len()), (1, 1, 0));
        assert!(Plan::parse("not json").is_err());
        assert_eq!(Plan::parse("{}").unwrap().delete.len(), 0);
    }

    #[test]
    fn install_setup_then_uninstall_leaves_nothing_behind() {
        let root = scratch("cycle");
        let (dir, desktop, menu) = (root.join("app"), root.join("desktop"), root.join("menu"));
        std::fs::create_dir_all(dir.join("lang")).unwrap();
        std::fs::write(dir.join("lang").join("en.json"), "{}").unwrap();
        let exe = dir.join(if cfg!(windows) { "launcher.exe" } else { "launcher" });
        std::fs::write(&exe, "x").unwrap();
        let places = Places { desktop: Some(desktop.clone()), menu: Some(menu.clone()), reg_key: "NiHaoInstallerTest" };
        let installed = Installed { version: "0.0.1".into(), dir: dir.clone(), exe: Some(exe) };

        register(&installed, true, &places).unwrap();
        assert!(dir.join(UNINSTALLER).is_file() && dir.join(MARKER).is_file());
        assert_eq!(std::fs::read_to_string(dir.join(MARKER)).unwrap(), installed.exe.as_ref().unwrap().file_name().unwrap().to_str().unwrap());
        assert!(desktop.join(shortcut_file()).is_file() && menu.join(shortcut_file()).is_file());
        #[cfg(windows)]
        {
            use winreg::{enums::HKEY_CURRENT_USER, RegKey};
            let key = RegKey::predef(HKEY_CURRENT_USER)
                .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Uninstall\NiHaoInstallerTest")
                .unwrap();
            assert_eq!(key.get_value::<String, _>("DisplayName").unwrap(), APP_NAME);
            assert_eq!(key.get_value::<String, _>("DisplayVersion").unwrap(), "0.0.1");
            assert!(key.get_value::<String, _>("UninstallString").unwrap().ends_with("uninstall.exe\""));
        }

        let _ = std::fs::remove_file(desktop.join(shortcut_file()));
        register(&installed, false, &places).unwrap();
        assert!(!desktop.join(shortcut_file()).exists());

        quick(&dir, &dir.join(UNINSTALLER), &Plan::default()).unwrap();
        unregister(&dir, &places);
        assert!(!dir.join("lang").exists() && !installed.exe.as_ref().unwrap().exists());
        assert!(!menu.join(shortcut_file()).exists());
        #[cfg(windows)]
        {
            use winreg::{enums::HKEY_CURRENT_USER, RegKey};
            assert!(RegKey::predef(HKEY_CURRENT_USER)
                .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Uninstall\NiHaoInstallerTest")
                .is_err());
        }
        let _ = std::fs::remove_dir_all(&root);
    }
}
