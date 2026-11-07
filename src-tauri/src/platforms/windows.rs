use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::{Child, Command};

/// Silent one-shot helpers (`cargo build`, `taskkill`) get no console; otherwise Windows allocates
/// one for them.
const CREATE_NO_WINDOW: u32 = 0x08000000;
/// The module's UI dev server *is* meant to be watched, so it gets its own console window.
const CREATE_NEW_CONSOLE: u32 = 0x00000010;

pub fn no_window(cmd: &mut Command) -> &mut Command {
    cmd.creation_flags(CREATE_NO_WINDOW)
}

pub fn own_console(cmd: &mut Command) -> &mut Command {
    cmd.creation_flags(CREATE_NEW_CONSOLE)
}

/// `npm` is a `.cmd` shim on Windows, so it has to go through `cmd /C`.
pub fn npm() -> Command {
    let mut cmd = Command::new("cmd");
    cmd.args(["/C", "npm"]);
    cmd
}

/// Kills `child` and everything it spawned: `child` is the `cmd /C npm run dev` wrapper, and a
/// plain `kill()` would only stop `cmd.exe` and leave the actual Vite/node process running.
pub fn kill_process_tree(child: &mut Child) {
    let mut cmd = Command::new("taskkill");
    cmd.args(["/PID", &child.id().to_string(), "/T", "/F"]);
    let _ = no_window(&mut cmd).output();
}

pub fn open_folder(dir: &Path) -> Result<(), String> {
    Command::new("explorer").arg(dir).spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Registers `nihaolauncher://` for the current user (no elevation); idempotent and best-effort.
/// See `deeplink.rs`.
pub fn register_protocol(scheme: &str) {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    let Ok(exe) = std::env::current_exe() else { return };
    let exe = exe.to_string_lossy().to_string();

    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let Ok((base, _)) = hkcu.create_subkey(format!("Software\\Classes\\{scheme}")) else { return };
    let _ = base.set_value("", &format!("URL:{scheme} protocol"));
    let _ = base.set_value("URL Protocol", &"");

    if let Ok((icon_key, _)) = base.create_subkey("DefaultIcon") {
        let _ = icon_key.set_value("", &format!("{exe},0"));
    }
    if let Ok((command_key, _)) = base.create_subkey("shell\\open\\command") {
        let _ = command_key.set_value("", &format!("\"{exe}\" \"%1\""));
    }
}
