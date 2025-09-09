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
        
        // Get current macOS version
        const { execSync } = require('child_process');
        const macOSVersion = execSync('sw_vers -productVersion', { encoding: 'utf8' }).trim();
        const majorVersion = parseInt(macOSVersion.split('.')[0]);
        
        // Different macOS versions have different minimum requirements
        // due to ___isPlatformVersionAtLeast symbol compatibility
        let minRequired;
        if (majorVersion >= 15) {
            minRequired = 15.5;  // macOS 15+ needs 15.5
        } else if (majorVersion >= 14) {
            minRequired = 14.0;  // macOS 14 might work with 14.0
        } else {
            minRequired = 13.0;  // macOS 13 might work with 13.0
        }
        
        // Check if debug build first - Metal doesn't work in debug mode
        if (!isRelease) {
            console.error('⚠️  Metal GPU acceleration detected but debug builds will fail!');
            console.error('');
            console.error('💡 Use: bun dev --release');
            console.error('');
            process.exit(1);
        }
        
        if (!deploymentTarget) {
            console.log('⚠️  MACOSX_DEPLOYMENT_TARGET not set (will use dev-metal.sh)');
            // Don't exit - the dev script will handle this with dev-metal.sh
            return; // Skip the rest of the deployment target checks
        } else if (parseFloat(deploymentTarget) < minRequired) {
            console.error('⚠️  MACOSX_DEPLOYMENT_TARGET=' + deploymentTarget + ' is too old for Metal (needs >= ' + minRequired + ')');
            console.error('💡 Fix: Set a higher version or let auto-detection handle it:');
            console.error('   bun dev --release');
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