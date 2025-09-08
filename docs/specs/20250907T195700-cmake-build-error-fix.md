# CMake Build Error Fix - Illegal Instruction on M4 Mac

## Problem
Getting an illegal instruction error (SIGILL) when running `bun dev` from `./apps/whispering`. The error occurs in a CMake test compile binary (`cmTC_8bd7b`) during the build process.

## Analysis
- **Error Type**: EXC_BAD_INSTRUCTION (SIGILL) - illegal instruction error
- **Process**: CMake test binary crashes immediately on startup
- **System**: M4 Mac (Mac16,10) running macOS 15.6.1
- **Architecture**: ARM64 native (not Rosetta)
- **Context**: Happens when building Tauri app's native dependencies

## Root Cause Hypothesis
The CMake configuration is likely generating test binaries with incorrect architecture flags or instruction sets for the M4 processor. This commonly happens when:
1. CMake cache contains stale configuration
2. Wrong compiler flags for Apple Silicon
3. Dependencies not properly configured for ARM64

## Troubleshooting Plan

### Phase 1: Clean Build Environment
- [ ] Clean all build caches and artifacts
- [ ] Remove CMake cache files
- [ ] Clear Rust/Cargo build cache
- [ ] Clear node_modules and reinstall

### Phase 2: Verify Toolchain
- [ ] Check Rust toolchain version and target
- [ ] Verify CMake version compatibility
- [ ] Check Xcode Command Line Tools version
- [ ] Verify bun/node compatibility

### Phase 3: Investigate Build Configuration
- [ ] Check for architecture-specific flags in build configs
- [ ] Look for hardcoded x86_64 references
- [ ] Review Cargo.toml for native dependencies
- [ ] Check for environment variables affecting builds

### Phase 4: Fix Implementation
- [ ] Apply necessary configuration changes
- [ ] Test the build
- [ ] Document the solution

## Solution Applied

### Root Cause
The CMake build process was generating test binaries with incorrect instruction sets for the M4 processor. This occurred when building native dependencies (whisper-rs with Metal support and cpal audio library) that use CMake internally.

### Fix Implementation
1. Created `.cargo/config.toml` in `src-tauri/` to force proper architecture flags:
   - Set `target-cpu=native` for Rust compilation
   - Specified `aarch64-apple-darwin` as the build target
   - Added environment variables for C/C++ compilers

2. Created `build-fix.sh` script that:
   - Sets `CFLAGS`, `CXXFLAGS`, and `CMAKE_OSX_ARCHITECTURES` to `arm64`
   - Clears any stale CMake caches before building
   - Runs the build with proper environment

### How to Use
Instead of running `bun dev` directly, use:
```bash
cd apps/whispering
./build-fix.sh
```

Or set environment variables manually:
```bash
export CFLAGS="-arch arm64"
export CXXFLAGS="-arch arm64"
export CMAKE_OSX_ARCHITECTURES="arm64"
bun dev
```

### Prevention
The `.cargo/config.toml` file should prevent this issue from recurring. If it does:
1. Clear all build caches (`cargo clean`, remove `target/` and `node_modules/`)
2. Ensure Xcode Command Line Tools are up to date
3. Use the build-fix.sh script for a clean build