#!/usr/bin/env bash
set -euo pipefail

# Configuration — must match the Scan API spec version
SPLICE_TAG="0.5.10"
SPLICE_REPO="https://github.com/hyperledger-labs/splice.git"

# DARs needed for Scan API typed payloads.
# These are the latest versions at the SPLICE_TAG that contain
# the templates returned by the Scan API.
DAR_FILES=(
  "splice-amulet-0.1.15.dar"                # Splice.ValidatorLicense, Splice.AmuletRules, Splice.Round
  "splice-amulet-name-service-0.1.16.dar"    # Splice.Ans (AnsEntry, AnsRules)
  "splice-dso-governance-0.1.21.dar"         # Splice.DSO.SvState (SvNodeState)
)

VENDOR_DIR="$(cd "$(dirname "$0")/.." && pwd)/vendor"
mkdir -p "$VENDOR_DIR"

# Skip if all DARs already present
all_present=true
for dar in "${DAR_FILES[@]}"; do
  if [ ! -f "$VENDOR_DIR/$dar" ]; then
    all_present=false
    break
  fi
done

if [ "$all_present" = true ]; then
  echo "All vendor DARs already present, skipping download."
  ls -la "$VENDOR_DIR"/*.dar
  exit 0
fi

echo "== Downloading Splice DARs from tag ${SPLICE_TAG}..."

TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT

echo "Cloning Splice repository (sparse, tag only)..."
git clone --depth 1 --branch "$SPLICE_TAG" --filter=blob:none --sparse "$SPLICE_REPO" "$TEMP_DIR/splice"
cd "$TEMP_DIR/splice"
git sparse-checkout set daml/dars

DARS_DIR="$TEMP_DIR/splice/daml/dars"
if [ ! -d "$DARS_DIR" ]; then
  echo "ERROR: daml/dars directory not found"
  exit 1
fi

for dar in "${DAR_FILES[@]}"; do
  if [ -f "$DARS_DIR/$dar" ]; then
    echo "  Copying $dar..."
    cp "$DARS_DIR/$dar" "$VENDOR_DIR/"
  else
    echo "  WARNING: $dar not found in Splice repository at tag $SPLICE_TAG"
    echo "  Available files matching pattern:"
    ls "$DARS_DIR" | grep "$(echo "$dar" | sed 's/-[0-9].*//')" || true
  fi
done

echo "== Vendor download complete!"
ls -la "$VENDOR_DIR"/*.dar
