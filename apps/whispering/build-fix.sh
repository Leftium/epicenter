#!/bin/bash
# Build fix script for M4 Mac illegal instruction error

# Set architecture flags
export CFLAGS="-arch arm64"
export CXXFLAGS="-arch arm64"
export CMAKE_OSX_ARCHITECTURES="arm64"
export MACOSX_DEPLOYMENT_TARGET="10.15"

# Clear any stale CMake caches
find . -name "CMakeCache.txt" -delete 2>/dev/null
find . -name "CMakeFiles" -type d -exec rm -rf {} + 2>/dev/null

# Run the dev build
echo "Starting build with proper architecture flags..."
bun dev