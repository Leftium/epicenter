#!/bin/bash
# Auto-detect macOS version and set deployment target for Metal builds

# Get macOS version
MACOS_VERSION=$(sw_vers -productVersion)
MAJOR_VERSION=$(echo $MACOS_VERSION | cut -d. -f1)
MINOR_VERSION=$(echo $MACOS_VERSION | cut -d. -f2)

# Determine minimum deployment target based on macOS version
if [ "$MAJOR_VERSION" -ge 15 ]; then
    # macOS 15+ (Sequoia) needs 15.5+ for Metal (based on testing)
    TARGET_VERSION="15.5"
elif [ "$MAJOR_VERSION" -eq 14 ]; then
    # macOS 14 (Sonoma) might work with 14.0
    TARGET_VERSION="14.0"  
elif [ "$MAJOR_VERSION" -eq 13 ]; then
    # macOS 13 (Ventura) might work with 13.0
    TARGET_VERSION="13.0"
else
    echo "⚠️  Metal GPU acceleration requires macOS 13.0 or later"
    echo "   Current: macOS $MACOS_VERSION"
    exit 1
fi

# Allow override via environment variable
DEPLOYMENT_TARGET=${MACOSX_DEPLOYMENT_TARGET:-$TARGET_VERSION}

echo "🍎 Detected macOS $MACOS_VERSION, using deployment target: $DEPLOYMENT_TARGET"

# Set all required environment variables and run the command
export MACOSX_DEPLOYMENT_TARGET="$DEPLOYMENT_TARGET"
export CFLAGS="${CFLAGS:--mmacosx-version-min=$DEPLOYMENT_TARGET}"
export CXXFLAGS="${CXXFLAGS:--mmacosx-version-min=$DEPLOYMENT_TARGET}" 
export RUSTFLAGS="${RUSTFLAGS:--C link-arg=-mmacosx-version-min=$DEPLOYMENT_TARGET}"

# Run the passed command with the environment set
exec "$@"