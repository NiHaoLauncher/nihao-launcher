pub mod ffi;
pub mod files;

pub use ffi::{make_plugin_handle, FfiBuffer, PluginHandle, RawPluginVTable, API_VERSION};
pub use files::{read_game_settings, write_atomic, GAME_SETTINGS_FILE_NAME};

pub struct GameInfo {
    pub name: &'static str,
    pub version: &'static str,
    pub autors: Vec<String>,

    pub api_version: &'static str,
}

/// Owned variant of [`GameInfo`] — the shape that actually crosses the FFI boundary as JSON,
/// since `&'static str` only makes sense inside the process that produced it.
#[derive(serde::Serialize, serde::Deserialize)]
pub struct GameInfoOwned {
    pub name: String,
    pub version: String,
    pub autors: Vec<String>,
    pub api_version: String,
}

impl From<GameInfo> for GameInfoOwned {
    fn from(info: GameInfo) -> Self {
        GameInfoOwned {
            name: info.name.to_string(),
            version: info.version.to_string(),
            autors: info.autors,
            api_version: info.api_version.to_string(),
        }
    }
}

pub trait GameSupport: Send + Sync {
    fn game(&self) -> GameInfo;
    fn get_ui_bundle(&self) -> &str;

    /// Universal method to call plugin-specific logic
    fn call(&self, method: &str, args: serde_json::Value) -> Result<serde_json::Value, String>;

    /// Returns raw asset data for the custom protocol
    fn get_asset_data(&self, path: &str) -> Option<Vec<u8>>;
}

/// Trait to normalize different return types into the standard Result<Value, String>
pub trait ToModuleResult {
    fn to_module_result(self) -> Result<serde_json::Value, String>;
}

// Blanket impl for any `Result<T, E>` where `T` serializes to JSON and `E` displays as a string.
impl<T, E> ToModuleResult for Result<T, E>
where
    T: serde::Serialize,
    E: std::fmt::Display,
{
    fn to_module_result(self) -> Result<serde_json::Value, String> {
        match self {
            Ok(val) => serde_json::to_value(val).map_err(|e| e.to_string()),
            Err(err) => Err(err.to_string()),
        }
    }
}


#[macro_export]
macro_rules! declare_module_call {
    ( $( $name:ident ( $($content:tt)* ) ),* $(,)? ) => {
        fn call(&self, method: &str, args: serde_json::Value) -> Result<serde_json::Value, String> {
            $(
                let res = $crate::declare_module_call!(@item method args $name ($($content)*));
                if let Some(r) = res { return r; }
            )*
            Err(format!("Method '{}' not found in module", method))
        }
    };

    (@item $method:ident $args:ident service ($svc:path)) => {
        $svc($method, $args.clone())
    };

    (@item $method:ident $args:ident $func:ident ( $($arg:ident : $ty:ty),* )) => {
        if $method == stringify!($func) {
            #[derive(serde::Deserialize)]
            struct Args { $($arg: $ty),* }
            let parsed: Args = serde_json::from_value($args.clone())
                .map_err(|e| format!("Invalid arguments for '{}': {}", stringify!($func), e))?;
            
            use $crate::ToModuleResult;
            Some($func($(parsed.$arg),*).to_module_result())
        } else {
            None
        }
    };
}

#[macro_export]
macro_rules! declare_service {
    (
        $( $func:ident ( $($arg:ident : $ty:ty),* ) ),*
    ) => {
        // `None` = method not recognized (so `declare_module_call!` falls through to other
        // handlers); `Some(Err(_))` is a real failure for a method this service owns and must
        // propagate as-is, not be mistaken for "not found".
        pub fn service(method: &str, args: serde_json::Value) -> Option<Result<serde_json::Value, String>> {
            match method {
                $(
                    stringify!($func) => {
                        Some((|| -> Result<serde_json::Value, String> {
                            #[derive(serde::Deserialize)]
                            struct Args { $($arg: $ty),* }
                            let parsed: Args = serde_json::from_value(args)
                                .map_err(|e| format!("Invalid arguments for '{}' in service: {}", stringify!($func), e))?;

                            use $crate::ToModuleResult;
                            $func($(parsed.$arg),*).to_module_result()
                        })())
                    },
                )*
                _ => None
            }
        }
    };
}

#[macro_export]
macro_rules! game_info_from_cargo {
    () => {
        $crate::GameInfo {
            name: env!("CARGO_PKG_NAME"),
            version: env!("CARGO_PKG_VERSION"),
            autors: env!("CARGO_PKG_AUTHORS")
                .split(':')
                .map(|s| s.to_string())
                .collect(),
            api_version: "0.0.1", 
        }
    };
}
