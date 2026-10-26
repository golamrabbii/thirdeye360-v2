#!/bin/bash
set -euo pipefail

# Default input directory
DEFAULT_INPUT_DIR="/mnt/ssd_disk/third-eye-360"
TMP_DIR="/mnt/ssd_disk/third-eye-360/tmp"   # temp directory

# Usage check
INPUT_DIR="${1:-$DEFAULT_INPUT_DIR}"   # Use argument if provided, otherwise default
PARALLEL_JOBS="${2:-6}"                # default 6 jobs if not specified

# Server directories
BINARY=/mnt/ssd_disk/third-eye-360/blur360/bin/equirect-blur-image
MODEL_DIR=/mnt/ssd_disk/third-eye-360/blur360/models
LOG=/mnt/ssd_disk/third-eye-360/blur360/batch_360.log
JOBLOG=/mnt/ssd_disk/third-eye-360/blur360/joblog_360.tsv

# Make directories if they don't exist
mkdir -p "$(dirname "$LOG")"
mkdir -p "$TMP_DIR"

# Cleanup function
cleanup() {
    echo "Cleaning up temporary files in $TMP_DIR..."
    rm -f "$TMP_DIR"/*.jpg
    echo "Cleanup complete."
}
trap cleanup EXIT  # run cleanup on script exit

echo "Starting batch process at $(date)" | tee -a "$LOG"
echo "Input folder: $INPUT_DIR" | tee -a "$LOG"
echo "Parallel jobs: $PARALLEL_JOBS" | tee -a "$LOG"
echo "Temporary files in: $TMP_DIR" | tee -a "$LOG"

# Count total images for ETA
TOTAL_IMAGES=$(find "$INPUT_DIR" -type f -iname '*.jpg' ! -iname '*comp.jpg' | wc -l)
echo "Total images to process: $TOTAL_IMAGES" | tee -a "$LOG"

# Export variables for GNU parallel
export BINARY MODEL_DIR LOG TMP_DIR

# Function to process one image
process_image() {
    local IMG="$1"
    TMP=$(mktemp --tmpdir="$TMP_DIR" --suffix=.jpg)  # create temp file in TMP_DIR

    # Run blur binary
    "$BINARY" -b -m="$MODEL_DIR" -o="$TMP" "$IMG"

    # Copy metadata from original to blurred image
    exiftool -overwrite_original -TagsFromFile "$IMG" "$TMP" >/dev/null 2>&1

    # Replace original
    mv "$TMP" "$IMG"

    # Update log
    echo "$(date '+%F %T') Processed: $IMG" >> "$LOG"
}

export -f process_image

# Run all images in parallel
nohup find "$INPUT_DIR" -type f -iname '*.jpg' ! -iname '*comp.jpg' \
  | parallel --bar -j "$PARALLEL_JOBS" --joblog "$JOBLOG" --resume process_image {} \
  >> "$LOG" 2>&1 &

echo "Batch job launched in background."
echo "Check live progress with: tail -f $LOG"
echo "Job details per image: less +F $JOBLOG"
