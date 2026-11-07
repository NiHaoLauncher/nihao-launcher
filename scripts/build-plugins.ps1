# Build UI for plugins
Write-Host "Building UI for Minecraft..."
pushd "plugin-sources/games/minecraft/ui"
npm install
npm run build
popd

# Build all workspace members
cargo build --release --workspace

# Ensure plugins directory exists
if (!(Test-Path "plugins")) {
    New-Item -ItemType Directory -Name "plugins"
}

# Copy DLLs from target/release to plugins/ — game plugins (e.g. minecraft.dll) are
# cdylib workspace members, so they land here as plain "<package-name>.dll", not under
# any "-plugin" suffix; the main launcher itself builds as an .exe, not a .dll, so a
# blanket copy can't accidentally pick it up.
Get-ChildItem "target/release/*.dll" | ForEach-Object {
    Copy-Item $_.FullName "plugins/" -Force
    Write-Host "Copied: $($_.Name)"
}

Write-Host "Plugins updated successfully!"
