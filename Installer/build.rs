// Embeds the icon and the version details (the name Windows shows in Task Manager / UAC, the
// publisher in the file's properties) into the .exe. A program with a full version resource and a
// signature (srcipts/sign.mjs) is far less likely to be flagged by antivirus heuristics.
fn main() {
    #[cfg(windows)]
    winresource::WindowsResource::new()
        .set_icon("assets/icon.ico")
        .set("FileDescription", "NiHao Launcher Installer")
        .set("ProductName", "NiHao Launcher")
        .set("CompanyName", "NiHao")
        .set("OriginalFilename", "nihao-installer.exe")
        .compile()
        .expect("cannot embed the icon");
}
