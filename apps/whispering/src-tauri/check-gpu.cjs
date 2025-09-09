const fs = require('fs');
const path = require('path');

try {
    const cargoToml = fs.readFileSync(path.join(__dirname, 'Cargo.toml'), 'utf8');
    // Check if --release is in arguments or if the parent command includes --release
    const cmdArgs = process.argv.slice(2);
    const isRelease = cmdArgs.includes('--release') || 
                      process.env.NODE_OPTIONS && process.env.NODE_OPTIONS.includes('--release');

    // Check if any GPU features are enabled (not commented out)
    const gpuFeatures = [];
    let hasMetal = false;
    
    for (const line of cargoToml.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('whisper-rs') && !trimmed.startsWith('#')) {
            if (trimmed.includes('metal')) {
                gpuFeatures.push('Metal (macOS)');
                hasMetal = true;
            }
            if (trimmed.includes('cuda')) gpuFeatures.push('CUDA');
            if (trimmed.includes('vulkan')) gpuFeatures.push('Vulkan');
            if (trimmed.includes('hipblas')) gpuFeatures.push('ROCm/HIP');
        }
    }

    // Check deployment target for Metal on macOS
    if (hasMetal && process.platform === 'darwin') {
        const deploymentTarget = process.env.MACOSX_DEPLOYMENT_TARGET;
        const minRequired = 13.0;
        
        if (!deploymentTarget) {
            console.error('⚠️  Metal GPU acceleration requires MACOSX_DEPLOYMENT_TARGET >= ' + minRequired);
            console.error('');
            console.error('   Current: NOT SET (will default to 11.0 and fail)');
            console.error('');
            console.error('💡 Fix: Set deployment target to your macOS version:');
            console.error('   MACOSX_DEPLOYMENT_TARGET=13.0 bun dev' + (isRelease ? ' --release' : ''));
            console.error('');
            console.error('   Or add to your shell profile for permanent fix:');
            console.error('   echo \'export MACOSX_DEPLOYMENT_TARGET=13.0\' >> ~/.zshrc');
            console.error('');
            process.exit(1);
        } else if (parseFloat(deploymentTarget) < minRequired) {
            console.error('⚠️  Metal GPU acceleration requires MACOSX_DEPLOYMENT_TARGET >= ' + minRequired);
            console.error('');
            console.error('   Current: ' + deploymentTarget + ' (too old for Metal)');
            console.error('');
            console.error('💡 Fix: Use a higher deployment target:');
            console.error('   MACOSX_DEPLOYMENT_TARGET=13.0 bun dev' + (isRelease ? ' --release' : ''));
            console.error('');
            process.exit(1);
        }
        
        // Deployment target is good, but still warn about debug builds
        if (!isRelease) {
            console.error('✅ Metal GPU acceleration detected with valid deployment target (' + deploymentTarget + ')');
            console.error('');
            console.error('⚠️  Debug builds may still fail. Use release mode for better compatibility:');
            console.error('');
            console.error('💡 Use: bun dev --release');
            console.error('');
            process.exit(1);
        }
        
        // All good - Metal with valid deployment target and release mode
        console.log('✅ Metal GPU acceleration enabled (deployment target: ' + deploymentTarget + ', release mode)');
        
        // Check for potential cache issues
        const targetDir = path.join(__dirname, 'target');
        const deploymentFile = path.join(__dirname, '.last_deployment_target');
        
        try {
            // Check if we've changed deployment targets
            if (fs.existsSync(deploymentFile)) {
                const lastTarget = fs.readFileSync(deploymentFile, 'utf8').trim();
                if (lastTarget !== deploymentTarget) {
                    console.warn('');
                    console.warn('⚠️  Deployment target changed from ' + lastTarget + ' to ' + deploymentTarget);
                    console.warn('   This may cause linking errors due to cached artifacts.');
                    console.warn('');
                    console.warn('💡 Recommended: Clean and rebuild');
                    console.warn('   cd src-tauri && cargo clean && cd ..');
                    console.warn('   MACOSX_DEPLOYMENT_TARGET=' + deploymentTarget + ' bun dev --release');
                    console.warn('');
                }
            }
            
            // Save current deployment target
            fs.writeFileSync(deploymentFile, deploymentTarget);
            
            // Check if target directory exists (has cached builds)
            if (fs.existsSync(targetDir)) {
                const stats = fs.statSync(targetDir);
                const hoursSinceModified = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60);
                
                if (hoursSinceModified > 24) {
                    console.log('');
                    console.log('💡 Tip: Build cache is ' + Math.round(hoursSinceModified) + ' hours old');
                    console.log('   Consider cleaning if you experience linking errors:');
                    console.log('   cd src-tauri && cargo clean && cd ..');
                }
            }
        } catch (e) {
            // Ignore file system errors
        }
        
    } else if (gpuFeatures.length > 0 && !isRelease) {
        // Non-Metal GPU features or Metal on non-macOS
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