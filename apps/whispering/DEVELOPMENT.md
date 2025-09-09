# Whispering Development Guide

This guide covers development setup, building from source, and enabling GPU acceleration for Whispering.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Basic Build](#basic-build)
- [GPU Acceleration](#gpu-acceleration)
  - [macOS Metal](#macos-metal)
  - [Windows GPU Support](#windows-gpu-support)
  - [Linux GPU Support](#linux-gpu-support)
- [Troubleshooting](#troubleshooting)

## Prerequisites

### All Platforms

- [Node.js](https://nodejs.org/) (v18 or later)
- [Rust](https://rustup.rs/) (latest stable)
- [pnpm](https://pnpm.io/) package manager

### Platform-Specific

- **macOS**: Xcode Command Line Tools
- **Windows**: Microsoft C++ Build Tools
- **Linux**: Development packages (build-essential, pkg-config, libssl-dev)

## Basic Build

By default, Whispering builds without GPU acceleration for maximum compatibility:

```bash
# Install dependencies
pnpm install

# Build the application
pnpm tauri build
```

## GPU Acceleration

GPU acceleration can significantly improve transcription performance but requires additional SDKs and configuration.

### macOS Metal

Metal acceleration provides GPU support on Apple Silicon and Intel Macs.

#### Prerequisites

- macOS 11.0 or later
- Apple Silicon Mac (M1/M2/M3/M4) or Intel Mac with Metal support
- Xcode Command Line Tools (this is sufficient - full Xcode NOT required)

#### Verify Metal Support

```bash
# Check if Metal is available on your Mac
system_profiler SPDisplaysDataType | grep "Metal"
# Expected output: Metal Support: Metal 3 (or similar)

# Check if Command Line Tools are installed
xcode-select -p
# Expected output: /Library/Developer/CommandLineTools or /Applications/Xcode.app/Contents/Developer

# If you get an error, install Command Line Tools:
xcode-select --install

# Verify Metal framework is available (this is what's actually needed)
ls -la /Library/Developer/CommandLineTools/SDKs/MacOSX.sdk/System/Library/Frameworks/ | grep Metal
# Expected output: Should list Metal.framework and related frameworks

# Note: The metal compiler (xcrun metal) requires full Xcode but is NOT needed for Whispering
# Whispering uses pre-compiled Metal shaders through whisper-rs
```

#### Enable Metal in Build

Edit `src-tauri/Cargo.toml`:

```toml
[target.'cfg(target_os = "macos")'.dependencies]
# Uncomment the following line:
whisper-rs = { version = "0.15.0", features = ["metal"] }
# Comment out or remove the basic version:
# whisper-rs = { version = "0.15.0" }
```

#### Build with Metal

```bash
# Clean previous builds
cd src-tauri
cargo clean

# Build with Metal support (release mode)
cargo build --release
```

#### Development with Metal

For development with Metal enabled, use release mode to avoid linking issues:

```bash
# Run in development with Metal (uses release build internally)
bun dev --release
```

**Important Notes**:

- **Debug builds with Metal may fail** due to linking issues with `___isPlatformVersionAtLeast` symbol
- **Use release mode for development** when Metal is enabled
- The `metal` compiler tool (accessed via `xcrun metal`) requires full Xcode installation
- However, **Whispering does NOT require the metal compiler** to build with Metal support
- Whispering only needs the Metal framework (included in Command Line Tools)
- The whisper-rs crate uses pre-compiled Metal shaders, so compilation tools aren't needed

### Windows GPU Support

Windows supports both CUDA (NVIDIA) and Vulkan acceleration.

#### CUDA (NVIDIA GPUs)

##### Prerequisites

- NVIDIA GPU with CUDA Compute Capability 3.5 or higher
- [CUDA Toolkit 11.8 or 12.x](https://developer.nvidia.com/cuda-downloads)
- Visual Studio 2019 or 2022

##### Verify CUDA Installation

```powershell
# Check CUDA version
nvcc --version

# Verify CUDA_PATH environment variable
echo %CUDA_PATH%

# List NVIDIA GPUs
nvidia-smi
```

##### Install CUDA Toolkit

1. Download CUDA Toolkit from [NVIDIA Developer](https://developer.nvidia.com/cuda-downloads)
2. Run installer with default options
3. Verify environment variables are set:
   - `CUDA_PATH` (e.g., `C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.3`)
   - `CUDA_PATH_V12_3` (version-specific)

#### Vulkan (AMD/Intel/NVIDIA GPUs)

##### Prerequisites

- GPU with Vulkan support
- [Vulkan SDK](https://vulkan.lunarg.com/sdk/home)

##### Verify Vulkan Installation

```powershell
# Check Vulkan version
vulkaninfo --summary

# Verify VULKAN_SDK environment variable
echo %VULKAN_SDK%
```

##### Install Vulkan SDK

1. Download Vulkan SDK from [LunarG](https://vulkan.lunarg.com/sdk/home#windows)
2. Run installer
3. Verify `VULKAN_SDK` environment variable is set (e.g., `C:\VulkanSDK\1.3.275.0`)

#### Enable GPU Support in Build

Edit `src-tauri/Cargo.toml`:

```toml
[target.'cfg(target_os = "windows")'.dependencies]
# For CUDA support:
whisper-rs = { version = "0.15.0", features = ["cuda"] }
# For Vulkan support:
whisper-rs = { version = "0.15.0", features = ["vulkan"] }
# For both:
whisper-rs = { version = "0.15.0", features = ["cuda", "vulkan"] }
```

### Linux GPU Support

Linux supports CUDA, Vulkan, and ROCm (via HIP).

#### CUDA (NVIDIA GPUs)

##### Prerequisites

- NVIDIA GPU with CUDA support
- NVIDIA drivers (version 450.80.02 or later)
- CUDA Toolkit 11.8 or 12.x

##### Install CUDA

```bash
# Ubuntu/Debian
wget https://developer.download.nvidia.com/compute/cuda/repos/ubuntu2204/x86_64/cuda-keyring_1.1-1_all.deb
sudo dpkg -i cuda-keyring_1.1-1_all.deb
sudo apt-get update
sudo apt-get install cuda

# Fedora/RHEL
sudo dnf config-manager --add-repo https://developer.download.nvidia.com/compute/cuda/repos/fedora37/x86_64/cuda-fedora37.repo
sudo dnf install cuda
```

##### Verify CUDA Installation

```bash
# Check CUDA version
nvcc --version

# Verify CUDA libraries
ldconfig -p | grep cuda

# Check NVIDIA GPUs
nvidia-smi
```

#### Vulkan

##### Install Vulkan

```bash
# Ubuntu/Debian
sudo apt-get install vulkan-tools libvulkan-dev vulkan-validationlayers

# Fedora
sudo dnf install vulkan-tools vulkan-loader-devel vulkan-validation-layers

# Arch
sudo pacman -S vulkan-tools vulkan-headers vulkan-validation-layers
```

##### Verify Vulkan Installation

```bash
# Check Vulkan support
vulkaninfo --summary

# Test Vulkan rendering
vkcube
```

#### ROCm/HIP (AMD GPUs)

##### Prerequisites

- AMD GPU with ROCm support (check [ROCm documentation](https://docs.amd.com/en/latest/release/gpu_os_support.html))
- ROCm 5.0 or later

##### Install ROCm

```bash
# Ubuntu 22.04
wget https://repo.radeon.com/amdgpu-install/latest/ubuntu/jammy/amdgpu-install_6.0.60002-1_all.deb
sudo apt install ./amdgpu-install_6.0.60002-1_all.deb
sudo amdgpu-install --usecase=rocm
```

##### Verify ROCm Installation

```bash
# Check ROCm version
rocm-smi

# Verify HIP installation
hipconfig
```

#### Enable GPU Support in Build

Edit `src-tauri/Cargo.toml`:

```toml
[target.'cfg(all(unix, not(target_os = "macos")))'.dependencies]
# For CUDA:
whisper-rs = { version = "0.15.0", features = ["cuda"] }
# For Vulkan:
whisper-rs = { version = "0.15.0", features = ["vulkan"] }
# For ROCm/HIP:
whisper-rs = { version = "0.15.0", features = ["hipblas"] }
# For all:
whisper-rs = { version = "0.15.0", features = ["cuda", "vulkan", "hipblas"] }
```

## Troubleshooting

### Common Build Errors

#### Metal Linking Errors (macOS)

```
error: linking with `cc` failed
ld: symbol(s) not found for architecture arm64
```

or

```
Undefined symbols for architecture arm64:
  "___isPlatformVersionAtLeast", referenced from:
```

**Solutions**:

1. **Use release mode for development**:

   ```bash
   # Instead of regular dev mode
   bun dev --release
   ```

2. **Ensure Command Line Tools are installed**:

   ```bash
   # Install Command Line Tools if not present
   xcode-select --install

   # If you have full Xcode installed, switch to it:
   sudo xcode-select -s /Applications/Xcode.app

   # Or use Command Line Tools (usually sufficient):
   sudo xcode-select -s /Library/Developer/CommandLineTools

   # Verify the active developer directory
   xcode-select -p
   ```

   error: linking with `cc` failed
   ld: symbol(s) not found for architecture arm64

````

**Solution**: Ensure Xcode Command Line Tools are installed and up to date:

```bash
# Install Command Line Tools if not present
xcode-select --install

# If you have full Xcode installed, switch to it:
sudo xcode-select -s /Applications/Xcode.app

# Or use Command Line Tools (usually sufficient):
sudo xcode-select -s /Library/Developer/CommandLineTools

# Verify the active developer directory
xcode-select -p
````

error: linking with `cc` failed
ld: symbol(s) not found for architecture arm64

````

**Solution**: Ensure Xcode Command Line Tools are installed and up to date:

```bash
xcode-select --install
sudo xcode-select -s /Applications/Xcode.app
````

#### CUDA Not Found (Windows/Linux)

```
error: CUDA_PATH not found
```

**Solution**: Install CUDA Toolkit and ensure environment variables are set:

- Windows: Add `CUDA_PATH` to system environment variables
- Linux: Add to `.bashrc`: `export CUDA_PATH=/usr/local/cuda`

#### Vulkan SDK Not Found

```
error: VULKAN_SDK not found
```

**Solution**: Install Vulkan SDK and set environment variable:

- Windows: Installer should set automatically
- Linux: Add to `.bashrc`: `export VULKAN_SDK=/usr/local/vulkan`

#### Performance Not Improved with GPU

- Verify GPU is being utilized: Check GPU usage during transcription
- Ensure correct model size: Larger models benefit more from GPU acceleration
- Check thermal throttling: GPUs may throttle under sustained load

### Testing GPU Acceleration

To verify GPU acceleration is working:

1. **Monitor GPU Usage**:
   - macOS: Use Activity Monitor → Window → GPU History
   - Windows: Task Manager → Performance → GPU
   - Linux: `nvidia-smi` (NVIDIA), `radeontop` (AMD), or `intel_gpu_top` (Intel)

2. **Compare Performance**:

   ```bash
   # Build without GPU
   cargo build --release
   # Note transcription time for a test file

   # Build with GPU
   # (Edit Cargo.toml to enable GPU features)
   cargo build --release
   # Compare transcription time for the same file
   ```

3. **Check Logs**:
   Enable debug logging to see which backend is being used:
   ```bash
   RUST_LOG=debug cargo run
   ```

### Platform-Specific Notes

- **macOS**: Metal is only beneficial on Apple Silicon or recent Intel Macs
- **Windows**: CUDA typically provides better performance than Vulkan on NVIDIA GPUs
- **Linux**: hipBLAS support may require additional ROCm libraries

## Additional Resources

- [Whisper.cpp GPU Support](https://github.com/ggerganov/whisper.cpp#gpu-support)
- [CUDA Installation Guide](https://docs.nvidia.com/cuda/cuda-installation-guide-linux/)
- [Vulkan Tutorial](https://vulkan-tutorial.com/)
- [Metal Programming Guide](https://developer.apple.com/metal/)
- [ROCm Documentation](https://docs.amd.com/)
