#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cargo build --manifest-path "$ROOT/Cargo.toml" --release --target wasm32-unknown-unknown
mkdir -p "$ROOT/pkg"
cp "$ROOT/target/wasm32-unknown-unknown/release/aplicaciones_wasm.wasm" "$ROOT/pkg/aplicaciones_wasm.wasm"
printf 'WASM listo: %s\n' "$ROOT/pkg/aplicaciones_wasm.wasm"
