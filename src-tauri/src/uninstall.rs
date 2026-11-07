//! The uninstall page's backend. The uninstaller (`uninstall.exe`, made by the installer) starts the
//! launcher with `--uninstall`; the page lists what the launcher and each module keep on disk and the
//! user ticks what to delete. On confirm this writes `uninstall-plan.json` next to the uninstaller,
//! starts `uninstall.exe --apply` and exits, and the uninstaller then does the deleting once the
//! launcher is gone (see `Installer/src/setup.rs`, which reads the plan).
//!
//! A module only names its paths: it answers `uninstall_paths` with a list of absolute paths (its
//! data folders and files; the more it lists apart, the finer the user can choose). Labels, sizes,
//! the choice and the plan are the launcher's. The page sends back only item ids, so the webview
//! (which also runs themes) cannot make the uninstaller delete a path of its choosing.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::json;
use tauri::Manager;

use crate::get_program_path;
use crate::plugins::loader::Plugin;

const PLAN_FILE: &str = "uninstall-plan.json";
const UNINSTALLER: &str = if cfg!(windows) { "uninstall.exe" } else { "uninstall" };

/// What the page showed, kept so the confirm can be matched to it.
static OFFERED: Mutex<Option<Vec<Group>>> = Mutex::new(None);

/// One thing the user can keep or delete: a path of a module, or one of the launcher's own.
#[derive(Serialize, Clone, Debug)]
struct Item {
    /// Unique within its group.
    id: String,
    label: String,
    /// Translation key of `label`; the launcher's own items have one, a module's path does not.
    label_key: Option<String>,
    description: Option<String>,
    description_key: Option<String>,
    paths: Vec<PathBuf>,
    size: u64,
    /// Preselected for deletion.
    delete_by_default: bool,
}

/// One block on the page: the launcher's own data (`id` "launcher") or one module's.
#[derive(Serialize, Clone)]
pub struct Group {
    id: String,
    name: String,
    items: Vec<Item>,
}

/// The plan file the uninstaller reads. Paths that do not exist are ignored there.
#[derive(Serialize, Default, Debug, PartialEq)]
struct Plan {
    /// Deleted first, wherever they are.
    delete: Vec<PathBuf>,
    /// Never touched, even if they sit inside the launcher's folder (which is otherwise emptied).
    keep: Vec<PathBuf>,
    /// Folders removed afterwards if they are empty, deepest first.
    prune: Vec<PathBuf>,
}

pub fn requested(args: &[String]) -> bool {
    args.iter().any(|a| a == "--uninstall")
}

#[tauri::command]
pub fn is_uninstall_mode() -> bool {
    requested(&std::env::args().collect::<Vec<_>>())
}

/// A second launch with `--uninstall` (the uninstaller found the launcher already running): shows
/// the running one on the uninstall page. Returns whether `argv` was such a launch.
pub fn handle_second_instance(app: &tauri::AppHandle, argv: &[String]) -> bool {
    if !requested(argv) {
        return false;
    }
    if let Some(window) = app.get_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    let _ = app.emit_all("navigate", "/uninstall");
    true
}

/// Bytes in a file or a folder tree. Links are counted as themselves, never followed.
fn dir_size(path: &Path) -> u64 {
    let Ok(meta) = std::fs::symlink_metadata(path) else { return 0 };
    if !meta.is_dir() {
        return meta.len();
    }
    std::fs::read_dir(path).into_iter().flatten().flatten().map(|entry| dir_size(&entry.path())).sum()
}

fn launcher_group(dir: &Path) -> Group {
    let mut items = Vec::new();
    let settings = dir.join("local.data");
    if settings.exists() {
        items.push(Item {
            id: "settings".into(),
            label: "Settings and saved sign-in".into(),
            label_key: Some("uninstall.launcher.settings".into()),
            description: Some("Your preferences and the account the launcher stays signed in to.".into()),
            description_key: Some("uninstall.launcher.settings_hint".into()),
            size: dir_size(&settings),
            paths: vec![settings],
            delete_by_default: true,
        });
    }
    let themes = dir.join("themes");
    if themes.exists() {
        items.push(Item {
            id: "themes".into(),
            label: "Installed themes".into(),
            label_key: Some("uninstall.launcher.themes".into()),
            description: Some("Themes you added to the themes folder.".into()),
            description_key: Some("uninstall.launcher.themes_hint".into()),
            size: dir_size(&themes),
            paths: vec![themes],
            delete_by_default: true,
        });
    }
    Group { id: "launcher".into(), name: "NiHao Launcher".into(), items }
}

/// Names for a module's paths: each relative to the folder they share (`instances/Pack`, `libraries`),
/// or just the file name when there is one path. Nothing is preselected: the launcher cannot tell
/// what the player made from what can be downloaded again.
fn module_items(paths: Vec<PathBuf>) -> Vec<Item> {
    let mut paths: Vec<PathBuf> = paths.into_iter().filter(|p| p.is_absolute() && p.exists()).collect();
    paths.sort();
    paths.dedup();
    let parents: Vec<Vec<_>> = paths.iter().map(|p| p.parent().unwrap_or(p).components().collect()).collect();
    let shared = parents.first().map_or(0, |first| {
        (0..first.len()).take_while(|&i| parents.iter().all(|c| c.get(i) == Some(&first[i]))).count()
    });
    paths
        .into_iter()
        .map(|path| {
            let label = path.components().skip(shared).map(|c| c.as_os_str().to_string_lossy()).collect::<Vec<_>>().join("/");
            Item {
                id: path.to_string_lossy().into_owned(),
                label,
                label_key: None,
                description: Some(path.display().to_string()),
                description_key: None,
                size: dir_size(&path),
                paths: vec![path],
                delete_by_default: false,
            }
        })
        .collect()
}

fn collect_groups() -> Result<Vec<Group>, String> {
    let mut groups = vec![launcher_group(&get_program_path()?)];
    let mut plugins: Vec<(String, Arc<Plugin>)> =
        crate::LOADED_PLUGINS.lock().unwrap().iter().map(|(id, p)| (id.clone(), p.clone())).collect();
    plugins.sort_by(|a, b| a.0.cmp(&b.0));
    for (id, plugin) in plugins {
        // A module without the method, or one that fails, is left alone: its data stays.
        let Ok(value) = plugin.call("uninstall_paths", json!({})) else { continue };
        let Ok(paths) = serde_json::from_value::<Vec<PathBuf>>(value) else { continue };
        let items = module_items(paths);
        if !items.is_empty() {
            groups.push(Group { name: plugin.game().name, id, items });
        }
    }
    Ok(groups)
}

/// Everything the page offers. Sizes are summed up here, which can take a moment.
#[tauri::command]
pub async fn get_uninstall_options() -> Result<Vec<Group>, String> {
    let groups = tauri::async_runtime::spawn_blocking(collect_groups).await.map_err(|e| e.to_string())??;
    *OFFERED.lock().unwrap() = Some(groups.clone());
    Ok(groups)
}

/// `selected`: group id -> ids of the items to delete. What is not ticked is kept: the uninstaller
/// leaves it alone even where it sits inside the launcher's own folder.
fn build_plan(groups: &[Group], selected: &HashMap<String, Vec<String>>) -> Plan {
    let mut plan = Plan::default();
    for group in groups {
        let chosen: HashSet<&str> =
            selected.get(&group.id).map(|ids| ids.iter().map(String::as_str).collect()).unwrap_or_default();
        for item in &group.items {
            let paths = item.paths.iter().filter(|p| p.is_absolute());
            if chosen.contains(item.id.as_str()) {
                for path in paths {
                    plan.delete.push(path.clone());
                    plan.prune.extend(path.parent().map(Path::to_path_buf));
                }
            } else {
                plan.keep.extend(paths.cloned());
            }
        }
    }
    plan.prune.sort_by_key(|p| std::cmp::Reverse(p.components().count()));
    let mut seen = HashSet::new();
    plan.prune.retain(|p| seen.insert(p.clone()));
    plan
}

/// The webview's cache and storage live outside the launcher's folder; they go with the launcher.
fn webview_data_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    let identifier = &app.config().tauri.bundle.identifier;
    if identifier.is_empty() {
        return None;
    }
    tauri::api::path::local_data_dir().map(|d| d.join(identifier))
}

/// Writes the plan, starts the uninstaller and closes the launcher. The uninstaller waits for the
/// launcher's exe to be free, so the order here does not matter.
#[tauri::command]
pub async fn uninstall_apply(app: tauri::AppHandle, selected: HashMap<String, Vec<String>>) -> Result<(), String> {
    let groups = OFFERED.lock().unwrap().clone().ok_or("The uninstall page has not loaded its options yet")?;
    let dir = get_program_path()?;
    let uninstaller = dir.join(UNINSTALLER);
    if !uninstaller.is_file() {
        return Err(format!("'{}' is missing: this copy of the launcher was not set up by the installer", uninstaller.display()));
    }

    let mut plan = build_plan(&groups, &selected);
    plan.delete.extend(webview_data_dir(&app));
    let plan_path = dir.join(PLAN_FILE);
    let json = serde_json::to_vec_pretty(&plan).map_err(|e| e.to_string())?;
    tokio::fs::write(&plan_path, json).await.map_err(|e| format!("Cannot write the uninstall plan: {e}"))?;

    // From the temp folder, so the uninstaller does not keep the launcher's folder busy.
    let started = std::process::Command::new(&uninstaller).arg("--apply").current_dir(std::env::temp_dir()).spawn();
    if let Err(e) = started {
        let _ = tokio::fs::remove_file(&plan_path).await;
        return Err(format!("Cannot start the uninstaller: {e}"));
    }
    app.exit(0);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An absolute path on the OS the test runs on.
    fn absolute(path: &str) -> PathBuf {
        std::env::temp_dir().join("nihao-plan-test").join(path)
    }

    fn item(id: &str, path: &str) -> Item {
        Item {
            id: id.into(),
            label: id.into(),
            label_key: None,
            description: None,
            description_key: None,
            paths: vec![absolute(path)],
            size: 0,
            delete_by_default: false,
        }
    }

    fn group(id: &str, items: Vec<Item>) -> Group {
        Group { id: id.into(), name: id.into(), items }
    }

    fn choose(pairs: &[(&str, &[&str])]) -> HashMap<String, Vec<String>> {
        pairs.iter().map(|(g, ids)| (g.to_string(), ids.iter().map(|i| i.to_string()).collect())).collect()
    }

    #[test]
    fn ticked_items_are_deleted_and_the_rest_is_kept() {
        let mc = group("mc", vec![item("worlds", "game/instances/a"), item("libs", "game/libs"), item("assets", "game/assets")]);
        let plan = build_plan(&[mc], &choose(&[("mc", &["libs", "assets"])]));
        assert_eq!(plan.delete, [absolute("game/libs"), absolute("game/assets")]);
        assert_eq!(plan.keep, [absolute("game/instances/a")]);
        // The folder the deleted items sat in is dropped if that leaves it empty.
        assert_eq!(plan.prune, [absolute("game")]);
    }

    #[test]
    fn folders_left_empty_are_pruned_deepest_first() {
        let mc = group("mc", vec![item("a", "game/instances/a"), item("b", "game/libs")]);
        let plan = build_plan(&[mc], &choose(&[("mc", &["a", "b"])]));
        assert!(plan.keep.is_empty());
        assert_eq!(plan.prune, [absolute("game/instances"), absolute("game")]);
    }

    #[test]
    fn nothing_ticked_keeps_everything_and_the_webview_cannot_name_other_ids() {
        let launcher = group("launcher", vec![item("settings", "local.data")]);
        let plan = build_plan(&[launcher], &choose(&[("launcher", &["nope"]), ("other-group", &["settings"])]));
        assert!(plan.delete.is_empty());
        assert_eq!(plan.keep, [absolute("local.data")]);
    }

    #[test]
    fn relative_paths_from_a_module_are_dropped() {
        let mut bad = item("x", "ignored");
        bad.paths = vec![PathBuf::from("relative/dir")];
        let plan = build_plan(&[group("m", vec![bad])], &choose(&[("m", &["x"])]));
        assert_eq!(plan, Plan::default());
    }

    #[test]
    fn a_modules_paths_are_named_by_what_they_do_not_share() {
        let root = std::env::temp_dir().join(format!("nihao-module-items-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("instances/Pack")).unwrap();
        std::fs::create_dir_all(root.join("libraries")).unwrap();
        std::fs::write(root.join("instances/Pack/level.dat"), [0u8; 4]).unwrap();
        std::fs::write(root.join("libraries/a.jar"), [0u8; 6]).unwrap();

        let items = module_items(vec![root.join("libraries"), root.join("instances/Pack"), root.join("missing"), PathBuf::from("relative")]);
        assert_eq!(items.iter().map(|i| (i.label.as_str(), i.size)).collect::<Vec<_>>(), [("instances/Pack", 4), ("libraries", 6)]);
        assert!(items.iter().all(|i| !i.delete_by_default));

        let alone = module_items(vec![root.join("libraries")]);
        assert_eq!(alone[0].label, "libraries");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_launcher_offers_what_exists_next_to_the_exe() {
        let dir = std::env::temp_dir().join(format!("nihao-launcher-group-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("themes")).unwrap();
        std::fs::write(dir.join("themes/t.js"), [0u8; 7]).unwrap();
        assert_eq!(launcher_group(&dir).items.iter().map(|i| (i.id.as_str(), i.size)).collect::<Vec<_>>(), [("themes", 7)]);
        std::fs::write(dir.join("local.data"), [0u8; 3]).unwrap();
        assert_eq!(launcher_group(&dir).items.len(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
