use launcher_common::{GameInfoOwned, PluginHandle};
use libloading::{Library, Symbol};
use serde_json::Value;
use std::path::{Path, PathBuf};

pub struct Plugin {
    _library: Library,
    handle: PluginHandle,
}

// Safety: `PluginHandle`'s raw pointers only ever cross into the plugin's own
// `extern "C"` functions, which the plugin author guarantees are `Send + Sync`
// via the `GameSupport: Send + Sync` bound enforced at `export_plugin!` time.
unsafe impl Send for Plugin {}
unsafe impl Sync for Plugin {}

impl Plugin {
    /// Resolved relative to the running exe's own directory (`get_program_path()`), not the
    /// process's current working directory — CWD depends entirely on *how* you happened to
    /// launch the exe (a terminal in some other folder, `cargo tauri dev`, double-clicking it
    /// in Explorer, ...), so a plugin that resolved fine one way could silently vanish another.
    fn resolve_path(plugin_name: &str) -> Result<PathBuf, Box<dyn std::error::Error>> {
        let dll_name = format!("{}.{}", plugin_name, std::env::consts::DLL_EXTENSION);
        let program_dir = crate::get_program_path()?;

        // Пошук у різних папках (для зручності розробки)
        let paths = [
            program_dir.join("plugins").join(&dll_name),
            // Dev convenience: `cargo build` (workspace-wide) puts every member's build
            // artifact straight into `target/debug/`, right next to `nihao-client.exe` itself
            // — so a plugin built that way is already sitting beside the running exe.
            program_dir.join(&dll_name),
        ];

        for p in &paths {
            if p.exists() {
                return Ok(p.clone());
            }
        }

        Err(format!("Плагін {} не знайдено (перевірено: {:?})", plugin_name, paths).into())
    }

    pub fn load(plugin_name: &str) -> Result<Self, Box<dyn std::error::Error>> {
        let path = Self::resolve_path(plugin_name)?;
        Self::load_from_path(&path)
    }

    pub fn load_from_path(path: &Path) -> Result<Self, Box<dyn std::error::Error>> {
        unsafe {
            let library = Library::new(path)?;

            let get_plugin: Symbol<unsafe extern "C" fn() -> PluginHandle> =
                library.get(b"get_plugin")?;

            let handle = get_plugin();

            Ok(Plugin {
                _library: library,
                handle,
            })
        }
    }

    pub fn game(&self) -> GameInfoOwned {
        unsafe {
            let buf = (self.handle.vtable.game_info)(self.handle.data);
            let bytes = buf.as_slice().to_vec();
            let info: GameInfoOwned = serde_json::from_slice(&bytes).unwrap_or(GameInfoOwned {
                name: "Unknown".to_string(),
                version: "0.0.0".to_string(),
                autors: vec![],
                api_version: "0.0.0".to_string(),
            });
            (self.handle.vtable.free_buffer)(buf);
            info
        }
    }

    pub fn get_ui_bundle(&self) -> String {
        unsafe {
            let buf = (self.handle.vtable.get_ui_bundle)(self.handle.data);
            let bytes = buf.as_slice().to_vec();
            (self.handle.vtable.free_buffer)(buf);
            String::from_utf8_lossy(&bytes).into_owned()
        }
    }

    pub fn call(&self, method: &str, args: Value) -> Result<Value, String> {
        let envelope = serde_json::json!({ "method": method, "args": args });
        let input = serde_json::to_vec(&envelope).map_err(|e| e.to_string())?;

        unsafe {
            let buf = (self.handle.vtable.call)(self.handle.data, input.as_ptr(), input.len());
            let bytes = buf.as_slice().to_vec();
            (self.handle.vtable.free_buffer)(buf);

            let result: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
            let ok = result.get("ok").and_then(Value::as_bool).unwrap_or(false);
            if ok {
                Ok(result.get("data").cloned().unwrap_or(Value::Null))
            } else {
                Err(result
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("Unknown plugin error")
                    .to_string())
            }
        }
    }

    pub fn get_asset_data(&self, path: &str) -> Option<Vec<u8>> {
        unsafe {
            let buf =
                (self.handle.vtable.get_asset_data)(self.handle.data, path.as_ptr(), path.len());
            let bytes = buf.as_slice().to_vec();
            (self.handle.vtable.free_buffer)(buf);

            match bytes.split_first() {
                Some((1, rest)) => Some(rest.to_vec()),
                _ => None,
            }
        }
    }
}

impl Drop for Plugin {
    fn drop(&mut self) {
        unsafe {
            (self.handle.vtable.drop)(self.handle.data);
        }
    }
}
