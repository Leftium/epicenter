#!/bin/bash
# Metal GPU development build for macOS
#
# WHY THIS SCRIPT EXISTS:
# `bun dev --release` fails with Metal enabled on macOS 15+ due to a tauri limitation.
# Tauri doesn't properly forward environment variables (MACOSX_DEPLOYMENT_TARGET, CFLAGS, etc.)
# to native dependency build scripts like whisper-rs-sys's build.rs.
#
# This causes the infamous "___isPlatformVersionAtLeast" linking error.
#
# HOW IT WORKS:
# 1. Sets all required environment variables directly
# 2. Builds with cargo (bypassing tauri's build process)
# 3. Creates properly-linked whisper-rs-sys artifacts
# 4. Subsequent `bun dev --release` can reuse these artifacts
#
# USAGE:
# First time or after bun clean:
#   ./dev-metal.sh
#
# Subsequent runs (either works):
#   ./dev-metal.sh        # More reliable, always works
#   bun dev --release     # Reuses artifacts from dev-metal.sh

echo "🔨 Building with Metal support (direct cargo)..."
cd src-tauri

# Set all required environment variables
export MACOSX_DEPLOYMENT_TARGET=15.5
export CFLAGS="-mmacosx-version-min=15.5"
export CXXFLAGS="-mmacosx-version-min=15.5"
export RUSTFLAGS="-C link-arg=-mmacosx-version-min=15.5"

# Build directly with cargo
cargo build --release

if [ $? -eq 0 ]; then
    echo "✅ Build successful!"
    cd ..
    
    # Start both dev server and app
    echo "🚀 Starting development environment..."
    bun run dev:web &
    WEB_PID=$!
    
    sleep 2
    cd src-tauri
    ./target/release/whispering
    
    kill $WEB_PID 2>/dev/null
else
    echo "❌ Build failed!"
    exit 1
fi