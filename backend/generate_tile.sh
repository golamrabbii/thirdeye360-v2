#!/bin/bash

###############################################################################
# ThirdEye360 Tile Generator
# Generates new tiles to a temp file, then atomically replaces the live
# mbtiles only on success - a failed/interrupted run never touches the
# previous good tile dataset.
###############################################################################

API_URL="http://0.0.0.0:8001/api/features"
OUTPUT_MBFILE="/home/barikoi/third-eye-360/backend/tiledata/ThirdEye360.mbtiles"
TEMP_MBFILE="${OUTPUT_MBFILE}.tmp"
GEOJSON_FILE="/home/barikoi/third-eye-360/backend/features.geojson"
TMPDIR="/home/barikoi/third-eye-360/tmp_tile"

echo "[+] Bootstrapping tile generation workflow…"

# Run Tippecanoe (updated command) - write to temp file, never the live one
echo "[+] Running Tippecanoe with revised high-fidelity configuration…"
tippecanoe \
  -o "$TEMP_MBFILE" \
  -l ThirdEye360 \
  -Z7 -z18 \
  -B7 \
  --no-feature-limit \
  --no-tile-size-limit \
  --no-line-simplification \
  -r1 \
  --force \
  "$GEOJSON_FILE"

STATUS=$?

# Success Handling - atomic replace (same filesystem, so mv is atomic)
if [ $STATUS -eq 0 ]; then
  echo "[✅] Tile generation succeeded. Swapping in the new tile set…"
  mv -f "$TEMP_MBFILE" "$OUTPUT_MBFILE"
  if [ $? -eq 0 ]; then
    echo "[+] Live tiles updated: $OUTPUT_MBFILE"
  else
    echo "[⚠️] Swap failed - new tiles kept at $TEMP_MBFILE for manual recovery."
    exit 1
  fi
  echo "[+] Cleaning temporary files…"
  rm -rf "$TMPDIR"
  echo "------------------------------------------------------------"
  exit 0
fi

# Failure Handling - remove partial output, previous tiles remain untouched
echo "[❌] Tippecanoe failure detected. Code $STATUS."
rm -f "$TEMP_MBFILE"
echo "[+] Partial output removed. Previous tiles at $OUTPUT_MBFILE remain valid."
echo "[+] Cleanup complete. Execution concluded."
echo "------------------------------------------------------------"
exit 1
