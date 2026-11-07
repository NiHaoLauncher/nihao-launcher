//! FFI-safe boundary between the host and a dynamically loaded game plugin. A `*mut dyn
//! GameSupport` fat pointer is not FFI-safe (no stable ABI across separately compiled dylibs), so
//! this uses a plain `#[repr(C)]` vtable of `extern "C" fn` pointers plus JSON-over-byte-buffer
//! marshalling. Plugin authors never touch this module; see [`crate::export_plugin`].

use crate::{GameInfoOwned, GameSupport};
use std::ffi::c_void;

/// An owned byte buffer crossing the FFI boundary. Always freed by the side that allocated it (the
/// plugin) via [`RawPluginVTable::free_buffer`], never by the host's `Vec` destructor: the sides
/// may use different allocators.
#[repr(C)]
pub struct FfiBuffer {
    ptr: *mut u8,
    len: usize,
    cap: usize,
}

impl FfiBuffer {
    pub fn from_vec(mut v: Vec<u8>) -> Self {
        let ptr = v.as_mut_ptr();
        let len = v.len();
        let cap = v.capacity();
        std::mem::forget(v);
        FfiBuffer { ptr, len, cap }
    }

    /// Reconstructs the `Vec<u8>` this buffer was built from.
    ///
    /// # Safety
    /// Must be called exactly once per `FfiBuffer`, and only by the allocator that produced
    /// it (i.e. the plugin's own `free_buffer` shim) — never by the host directly.
    pub unsafe fn into_vec(self) -> Vec<u8> {
        Vec::from_raw_parts(self.ptr, self.len, self.cap)
    }

    /// Reads the bytes without taking ownership. The caller must still route the original
    /// `FfiBuffer` through `free_buffer` afterwards.
    ///
    /// # Safety
    /// `ptr`/`len` must describe a valid, initialized byte slice.
    pub unsafe fn as_slice(&self) -> &[u8] {
        std::slice::from_raw_parts(self.ptr, self.len)
    }
}

/// Version of the layout of [`PluginHandle`], [`RawPluginVTable`] and [`FfiBuffer`]. Raise it with any
/// change to them. A module exports it (`export_plugin!`) and the launcher compares it before it
/// calls anything else in the library, because a module built for another layout would be called
/// through the wrong function pointers.
pub const API_VERSION: u32 = 1;

/// Plain function-pointer vtable — every field is individually FFI-safe (no trait objects).
#[repr(C)]
pub struct RawPluginVTable {
    pub game_info: unsafe extern "C" fn(*mut c_void) -> FfiBuffer,
    pub get_ui_bundle: unsafe extern "C" fn(*mut c_void) -> FfiBuffer,
    /// `args` is a JSON-encoded `{"method": ..., "args": ...}` envelope.
    /// Returns a JSON-encoded `{"ok": true, "data": ...}` / `{"ok": false, "error": ...}` envelope.
    pub call: unsafe extern "C" fn(*mut c_void, *const u8, usize) -> FfiBuffer,
    /// `path` is a raw UTF-8 asset path. Returns a buffer whose first byte is a found-flag
    /// (0 = not found, rest ignored; 1 = found, remaining bytes are the raw asset data).
    pub get_asset_data: unsafe extern "C" fn(*mut c_void, *const u8, usize) -> FfiBuffer,
    pub free_buffer: unsafe extern "C" fn(FfiBuffer),
    pub drop: unsafe extern "C" fn(*mut c_void),
}

/// What a plugin's `get_plugin()` export returns: an opaque instance pointer plus the
/// vtable to call through it. A plain struct of pointers/fn-pointers — fully FFI-safe.
#[repr(C)]
pub struct PluginHandle {
    pub data: *mut c_void,
    pub vtable: RawPluginVTable,
}

#[derive(serde::Deserialize)]
struct CallEnvelope {
    method: String,
    args: serde_json::Value,
}

fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        s.to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "unknown panic".to_string()
    }
}

/// Boxes `instance` and builds an FFI-safe [`PluginHandle`] for it. Used by
/// [`crate::export_plugin`] — plugin authors should not need to call this directly.
pub fn make_plugin_handle<T: GameSupport + 'static>(instance: T) -> PluginHandle {
    let data = Box::into_raw(Box::new(instance)) as *mut c_void;

    // Every shim wraps its work in `catch_unwind`: a panic must not unwind across this `extern
    // "C"` boundary (undefined behavior, takes down the host). Caught panics become an error
    // response (or an empty/not-found buffer where there is no error envelope).

    unsafe extern "C" fn game_info_shim<T: GameSupport>(data: *mut c_void) -> FfiBuffer {
        let this = unsafe { &*(data as *const T) };
        let bytes = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let owned: GameInfoOwned = this.game().into();
            serde_json::to_vec(&owned).unwrap_or_default()
        }))
        .unwrap_or_default();
        FfiBuffer::from_vec(bytes)
    }

    unsafe extern "C" fn get_ui_bundle_shim<T: GameSupport>(data: *mut c_void) -> FfiBuffer {
        let this = unsafe { &*(data as *const T) };
        let bytes = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            this.get_ui_bundle().as_bytes().to_vec()
        }))
        .unwrap_or_default();
        FfiBuffer::from_vec(bytes)
    }

    unsafe extern "C" fn call_shim<T: GameSupport>(
        data: *mut c_void,
        ptr: *const u8,
        len: usize,
    ) -> FfiBuffer {
        let this = unsafe { &*(data as *const T) };
        let input = unsafe { std::slice::from_raw_parts(ptr, len) };

        let envelope = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            match serde_json::from_slice::<CallEnvelope>(input) {
                Ok(env) => match this.call(&env.method, env.args) {
                    Ok(v) => serde_json::json!({ "ok": true, "data": v }),
                    Err(e) => serde_json::json!({ "ok": false, "error": e }),
                },
                Err(e) => serde_json::json!({
                    "ok": false,
                    "error": format!("Invalid call envelope: {}", e)
                }),
            }
        }))
        .unwrap_or_else(|payload| {
            serde_json::json!({ "ok": false, "error": format!("Plugin panicked: {}", panic_message(&*payload)) })
        });
        FfiBuffer::from_vec(serde_json::to_vec(&envelope).unwrap_or_default())
    }

    unsafe extern "C" fn get_asset_data_shim<T: GameSupport>(
        data: *mut c_void,
        ptr: *const u8,
        len: usize,
    ) -> FfiBuffer {
        let this = unsafe { &*(data as *const T) };
        let path_bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
        let path = String::from_utf8_lossy(path_bytes);

        let bytes = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            match this.get_asset_data(&path) {
                Some(bytes) => {
                    let mut out = Vec::with_capacity(bytes.len() + 1);
                    out.push(1u8);
                    out.extend_from_slice(&bytes);
                    out
                }
                None => vec![0u8],
            }
        }))
        .unwrap_or_else(|_| vec![0u8]); // treat a panic as "not found" rather than crashing
        FfiBuffer::from_vec(bytes)
    }

    unsafe extern "C" fn free_buffer_shim(buf: FfiBuffer) {
        let _ = unsafe { buf.into_vec() };
    }

    unsafe extern "C" fn drop_shim<T>(data: *mut c_void) {
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            drop(unsafe { Box::from_raw(data as *mut T) });
        }));
    }

    PluginHandle {
        data,
        vtable: RawPluginVTable {
            game_info: game_info_shim::<T>,
            get_ui_bundle: get_ui_bundle_shim::<T>,
            call: call_shim::<T>,
            get_asset_data: get_asset_data_shim::<T>,
            free_buffer: free_buffer_shim,
            drop: drop_shim::<T>,
        },
    }
}

/// Generates the `#[no_mangle] extern "C" fn get_plugin()` export for a plugin crate.
/// Plugin authors write `launcher_common::export_plugin!(MyGameSupport, MyGameSupport);`
/// instead of hand-writing unsafe FFI code.
#[macro_export]
macro_rules! export_plugin {
    ($ty:ty, $ctor:expr) => {
        #[no_mangle]
        pub extern "C" fn plugin_api_version() -> u32 {
            $crate::API_VERSION
        }

        #[no_mangle]
        pub extern "C" fn get_plugin() -> $crate::PluginHandle {
            $crate::make_plugin_handle::<$ty>($ctor)
        }
    };
}
