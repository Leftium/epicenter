# Accessing Shell Commands in Tauri Apps

When building a Tauri desktop application, you sometimes need to execute command-line tools like `git` or other system utilities. But here's the thing that took me way too long to realize: GUI applications on macOS and Linux don't inherit the same PATH environment that your terminal has. And on Windows, there's a completely different bug where child processes sometimes can't find executables even when they're in PATH.

This guide shows you how to properly access shell commands in a Tauri v2 app, covering both the security configuration and the PATH fixes needed for reliable command execution.

## The Two-Part Solution

You need to do two things to reliably execute shell commands in Tauri:

1. **Parse command strings into program + args** instead of routing through a shell
2. **Fix the PATH environment** so GUI apps can find command-line tools

Let's dive into each.

## Part 1: Direct Command Execution

### Why direct execution?

Shell wrappers make every call more powerful than it needs to be. The current app command path parses a command string into a program and arguments, then executes it through Rust's `std::process::Command`. That keeps PATH resolution while avoiding shell injection risk and shell-specific quoting behavior.

### The Command Namespace

Use the Tauri namespace rather than importing Tauri shell APIs across the app:

```typescript
import { requireTauri } from '$lib/tauri';

const { data, error } = await requireTauri().command.execute('open .');
```

### Tauri Capabilities Configuration

For this to work, you need to configure Tauri's security capabilities to allow shell execution. In `src-tauri/capabilities/default.json`:

```json
{
  "permissions": [
    {
      "identifier": "core:default"
    }
  ]
}
```

Key points:
- **No shell plugin permission is needed** for the app's current command path
- **One command shape**: `tauri.command.execute(command)` is the supported app surface
- **No long-running spawn surface**: background recorders are owned by dedicated recorder commands

## Part 2: Fixing the PATH Environment

### The Problem

GUI applications launched from the dock/start menu don't inherit your shell's PATH. This means:
- On macOS: Homebrew-installed tools (`/opt/homebrew/bin`) aren't accessible
- On Linux: User-installed tools in `~/.local/bin` or `/usr/local/bin` might be missing
- On Windows: There's a bug where child processes sometimes can't access PATH at all

### The Solution: Path Fixing in lib.rs

In your `src-tauri/src/lib.rs`, fix the PATH before initializing Tauri:

```rust
#[tokio::main]
pub async fn run() {
    // Fix PATH environment for GUI applications on macOS and Linux
    // This ensures commands like ffmpeg installed via Homebrew are accessible
    let _ = fix_path_env::fix();
    
    // Fix Windows PATH inheritance bug
    // This ensures child processes can find ffmpeg on Windows
    fix_windows_path();
    
    // ... rest of Tauri initialization
}
```

### macOS and Linux: fix_path_env

Add to your `Cargo.toml`:
```toml
[dependencies]
fix-path-env = "0.0.0"  # Check for latest version
```

The `fix_path_env::fix()` function:
- Spawns a login shell to get the full PATH
- Updates the current process's PATH environment
- Ensures Homebrew paths (`/opt/homebrew/bin`, `/usr/local/bin`) are included

### Windows: Custom PATH Fix

Windows has a different issue where `Command::new()` sometimes ignores the parent's PATH. Here's the fix:

```rust
// src-tauri/src/windows_path.rs
#[cfg(target_os = "windows")]
pub fn fix_windows_path() {
    use std::env;
    
    // Get current PATH
    if let Ok(path) = env::var("PATH") {
        // Simply re-setting the PATH forces std::process::Command to use it
        env::set_var("PATH", path);
        println!("Windows PATH inheritance fixed");
    }
}

#[cfg(not(target_os = "windows"))]
pub fn fix_windows_path() {
    // No-op on non-Windows platforms
}
```

This weird workaround (getting PATH and immediately setting it back) forces Rust's `std::process::Command` to properly pass PATH to child processes.

## Usage Example: Opening System Settings

Here's how it all comes together for a one-shot system command:

```typescript
import { requireTauri } from '$lib/tauri';

const command =
  'open x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';

const result = await requireTauri().command.execute(command);
```

## Common Pitfalls

1. **Not fixing PATH**: Your app works in development (launched from terminal) but fails in production (launched from dock/installer)

2. **Expecting shell features**: The command path does not use `sh -c` or `cmd /c`, so pipes, redirects, glob expansion, and shell builtins are not available

3. **Platform assumptions**: Always test on all target platforms; PATH and executable lookup behavior varies significantly

## Testing Your Setup

1. **Development**: Launch your app from the terminal to test with full PATH
2. **Production simulation**: Launch your app from Finder/Explorer to test with limited PATH
3. **Command availability**: Test that commands like `ffmpeg --version` work from within your app
4. **Error handling**: Ensure your app gracefully handles missing commands

## Summary

Accessing shell commands in Tauri requires:
1. Executing through the app's `$lib/tauri` namespace
2. Parsing command strings into program + args, not shell wrappers
3. Fixing PATH environment for GUI applications on all platforms
4. Keeping long-running native work behind dedicated Tauri commands

With this setup, your Tauri app can reliably execute command-line tools regardless of how it's launched or what platform it's running on.
