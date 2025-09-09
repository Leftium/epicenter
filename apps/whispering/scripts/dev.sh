#!/bin/bash
# Development script for Whispering
# Handles platform-specific build requirements and GPU acceleration

# Parse arguments
ARGS="$@"

echo "🚀 Starting Whispering development..."

# Step 1: Check for conflicting build processes (fail fast if conflicts detected)
if [ "$FORCE_BUILD" = "true" ]; then
    echo "🚫 FORCE_BUILD=true - skipping conflict check"
elif [ "$PROMPT_KILL_BUILDS" = "true" ] && [ -t 0 ]; then
    # Interactive mode (only if stdin is a terminal, not CI)
    ./scripts/check-build-processes.sh
    if [ $? -ne 0 ]; then
        exit 1
    fi
else
    # Default: Safe mode for CI and non-interactive environments
    ./scripts/check-build-processes.sh --info-only
    if [ $? -ne 0 ]; then
        exit 1
    fi
fi

# Step 2: Run GPU checks
echo "🔍 Checking GPU configuration..."
bun src-tauri/check-gpu.cjs $ARGS
if [ $? -ne 0 ]; then
    echo "❌ GPU check failed"
    exit 1
fi

# Step 3: Platform-specific build routing
# Check if Metal is actually enabled by looking for uncommented metal feature
METAL_ENABLED=$(grep -E "^\s*whisper-rs.*metal" src-tauri/Cargo.toml | grep -v "^#" | wc -l)

if [ "$(uname)" = "Darwin" ] && [ "$1" = "--release" ] && [ "$METAL_ENABLED" -gt 0 ]; then
    # macOS release build with Metal support
    echo "🍎 macOS release build with Metal detected, using Metal-optimized build..."
    ./dev-metal.sh
else
    # Standard tauri dev for all other cases:
    # - Non-macOS platforms (Windows, Linux)
    # - macOS debug builds (will be caught by GPU check if Metal enabled)
    # - macOS release builds without Metal
    echo "🔧 Using standard tauri dev..."
    bun tauri dev $ARGS
fi