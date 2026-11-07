#!/bin/bash
set -e

# Шлях до папки з готовими плагінами
PLUGIN_DIR="../plugins"
mkdir -p $PLUGIN_DIR

cargo build --release --workspace

for lib in target/release/*.dll target/release/*.so target/release/*.dylib; do
    [ -f "$lib" ] && cp "$lib" "$PLUGIN_DIR/"
done

echo "Плагіни скопійовано в $PLUGIN_DIR"