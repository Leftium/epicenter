const fs = require('fs');
const path = require('path');

try {
    const cargoToml = fs.readFileSync(path.join(__dirname, 'Cargo.toml'), 'utf8');
    const isRelease = process.argv.includes('--release');

    // Check if any GPU features are enabled (not commented out)
    const gpuFeatures = [];
    for (const line of cargoToml.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('whisper-rs') && !trimmed.startsWith('#')) {
            if (trimmed.includes('metal')) gpuFeatures.push('Metal (macOS)');
            if (trimmed.includes('cuda')) gpuFeatures.push('CUDA');
            if (trimmed.includes('vulkan')) gpuFeatures.push('Vulkan');
            if (trimmed.includes('hipblas')) gpuFeatures.push('ROCm/HIP');
        }
    }

    if (gpuFeatures.length > 0 && !isRelease) {
        console.error('⚠️  GPU acceleration detected:', gpuFeatures.join(', '));
        console.error('');
        console.error('   Debug builds with GPU features will likely fail with linking errors!');
        console.error('');
        console.error('💡 Use: bun dev --release');
        console.error('🔗 See: DEVELOPMENT.md for platform-specific issues');
        console.error('');
        process.exit(1);
    }
} catch (error) {
    // If we can't read Cargo.toml, just proceed normally
    // This prevents the check from breaking the build process
}