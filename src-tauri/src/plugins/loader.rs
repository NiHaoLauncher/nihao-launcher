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
    /// Resolved relative to the exe's directory (`get_program_path()`), not the CWD, which depends
    /// on how the exe was launched.
    fn resolve_path(plugin_name: &str) -> Result<PathBuf, Box<dyn std::error::Error>> {
        // The name comes from the UI: only a bare module id, never a path to some other DLL.
        if plugin_name.is_empty() || !plugin_name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
            return Err(format!("Invalid plugin name '{}'", plugin_name).into());
        }
        let dll_name = format!("{}.{}", plugin_name, std::env::consts::DLL_EXTENSION);
        let program_dir = crate::get_program_path()?;

        let paths = [
            program_dir.join("plugins").join(&dll_name),
            // Dev convenience: workspace-wide `cargo build` puts every member's artifact in
            // `target/debug/` next to `nihao-client.exe`.
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

            // Before anything else is called through the library: is it built for this launcher?
            let api_version: Symbol<unsafe extern "C" fn() -> u32> = library.get(b"plugin_api_version").map_err(|_| {
                format!("'{}' has no plugin_api_version: it was built for an older launcher, rebuild it", path.display())
            })?;
            let theirs = api_version();
            if theirs != launcher_common::API_VERSION {
                return Err(format!(
                    "'{}' is built for module interface version {theirs}, this launcher speaks {}: rebuild it",
                    path.display(),
                    launcher_common::API_VERSION
                )
                .into());
            }

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

#[cfg(test)]
mod tests {
    use super::*;

    /// Needs the module built first: `cargo build -p minecraft`, then
    /// `cargo test -p nihao-client loads_the_built_module -- --ignored`.
    #[test]
    #[ignore]
    fn loads_the_built_module_after_the_interface_version_check() {
        let file = format!("{}minecraft{}", std::env::consts::DLL_PREFIX, std::env::consts::DLL_SUFFIX);
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../target/debug").join(file);
        let plugin = Plugin::load_from_path(&path).unwrap_or_else(|e| panic!("{e}"));
        assert_eq!(plugin.game().name, "Minecraft");
    }
}
