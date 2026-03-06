#!/usr/bin/env bash
set -euo pipefail

# Generate TypeScript bindings from vendor Splice DARs using dpm codegen-js.
# Output goes to codegen/js/ (same structure as c7/codegen/js/).

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
VENDOR_DIR="$PKG_DIR/vendor"
OUTPUT_DIR="$PKG_DIR/codegen/js"

# Find dpm
DPM="${DPM:-$HOME/.dpm/bin/dpm}"
if [ ! -x "$DPM" ]; then
  echo "ERROR: dpm not found at $DPM"
  echo "Set DPM env var to point to your dpm binary."
  exit 1
fi

# Verify vendor DARs exist
DARS=()
for dar in "$VENDOR_DIR"/*.dar; do
  if [ -f "$dar" ]; then
    DARS+=("$dar")
  fi
done

if [ ${#DARS[@]} -eq 0 ]; then
  echo "ERROR: No DAR files found in $VENDOR_DIR"
  echo "Run 'pnpm vendor' first."
  exit 1
fi

echo "== Generating TypeScript bindings from ${#DARS[@]} DARs..."
for dar in "${DARS[@]}"; do
  echo "  $(basename "$dar")"
done

rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

"$DPM" codegen-js "${DARS[@]}" -o "$OUTPUT_DIR" -s c7-digital/splice-codegen

echo "== Codegen complete!"
echo "Generated packages:"
ls -d "$OUTPUT_DIR"/*/ 2>/dev/null | while read -r dir; do
  echo "  $(basename "$dir")"
done
