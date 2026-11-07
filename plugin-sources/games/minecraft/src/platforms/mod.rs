//! Everything that differs per OS lives in `windows.rs` / `linux.rs` (same names in both), so the
//! rest of the plugin never branches on the OS itself. A new OS = a new file here.
#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::*;

#[cfg(not(windows))]
mod linux;
#[cfg(not(windows))]
pub use linux::*;
