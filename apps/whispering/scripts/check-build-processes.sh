#!/bin/bash

# Check for existing whisper/whispering build processes and optionally kill them
# Usage: 
#   ./check-build-processes.sh           # Interactive mode (show + prompt to kill)
#   ./check-build-processes.sh --info-only  # Info mode (show only, no prompts)

INFO_ONLY=false
if [ "$1" = "--info-only" ]; then
    INFO_ONLY=true
fi

echo "🔍 Checking for existing build processes..."

# Find whisper-related processes
CARGO_PROCESSES=$(ps aux | grep -E "cargo.*(whispering|whisper)" | grep -v grep | grep -v "check-build-processes")
CMAKE_PROCESSES=$(ps aux | grep -E "cmake.*(whisper|whispering)" | grep -v grep)
RUSTC_PROCESSES=$(ps aux | grep -E "rustc.*(whisper|whispering)" | grep -v grep)

# Check for rust-analyzer (informational only)
RUST_ANALYZER=$(ps aux | grep "rust-analyzer" | grep -v grep)

# Combine all processes
ALL_PROCESSES=""
if [ ! -z "$CARGO_PROCESSES" ]; then
    ALL_PROCESSES="$ALL_PROCESSES$CARGO_PROCESSES\n"
fi
if [ ! -z "$CMAKE_PROCESSES" ]; then
    ALL_PROCESSES="$ALL_PROCESSES$CMAKE_PROCESSES\n"
fi
if [ ! -z "$RUSTC_PROCESSES" ]; then
    ALL_PROCESSES="$ALL_PROCESSES$RUSTC_PROCESSES\n"
fi

# Show rust-analyzer info (informational only)
if [ ! -z "$RUST_ANALYZER" ]; then
    echo "ℹ️  rust-analyzer is running (may trigger builds on file changes):"
    echo "$RUST_ANALYZER" | head -3
    echo ""
fi



if [ -z "$ALL_PROCESSES" ]; then
    if [ ! -z "$RUST_ANALYZER" ]; then
        echo "✅ No active build processes found (but rust-analyzer is monitoring)"
    else
        echo "✅ No conflicting build processes found"
    fi
    exit 0
fi

echo "⚠️  Found existing build processes:"

# Extract PIDs and create clean summaries
PIDS=""
SAMPLE_PID=""
if [ ! -z "$CARGO_PROCESSES" ]; then
    echo "$CARGO_PROCESSES" | while read line; do
        PID=$(echo "$line" | awk '{print $2}')
        echo "  • cargo (PID $PID): building whispering"
        if [ -z "$SAMPLE_PID" ]; then
            SAMPLE_PID=$PID
        fi
    done
    PIDS="$PIDS $(echo "$CARGO_PROCESSES" | awk '{print $2}' | tr '\n' ' ')"
    SAMPLE_PID=$(echo "$CARGO_PROCESSES" | head -1 | awk '{print $2}')
fi

if [ ! -z "$CMAKE_PROCESSES" ]; then
    echo "$CMAKE_PROCESSES" | while read line; do
        PID=$(echo "$line" | awk '{print $2}')
        echo "  • cmake (PID $PID): building whisper"
    done
    PIDS="$PIDS $(echo "$CMAKE_PROCESSES" | awk '{print $2}' | tr '\n' ' ')"
    if [ -z "$SAMPLE_PID" ]; then
        SAMPLE_PID=$(echo "$CMAKE_PROCESSES" | head -1 | awk '{print $2}')
    fi
fi

if [ ! -z "$RUSTC_PROCESSES" ]; then
    echo "$RUSTC_PROCESSES" | while read line; do
        PID=$(echo "$line" | awk '{print $2}')
        echo "  • rustc (PID $PID): compiling whispering"
    done
    PIDS="$PIDS $(echo "$RUSTC_PROCESSES" | awk '{print $2}' | tr '\n' ' ')"
    if [ -z "$SAMPLE_PID" ]; then
        SAMPLE_PID=$(echo "$RUSTC_PROCESSES" | head -1 | awk '{print $2}')
    fi
fi

# Get PIDs from the original ALL_PROCESSES for killing (remove duplicates)
PIDS=$(echo -e "$ALL_PROCESSES" | awk '{print $2}' | sort -n | uniq | tr '\n' ' ')

echo ""

# Handle different modes
if [ "$INFO_ONLY" = "true" ]; then
    if [ ! -z "$ALL_PROCESSES" ]; then
        echo ""
        echo "❌ Build conflicts detected! Cannot continue safely."
        echo ""
        echo "🚦 To resolve conflicts:"
        echo "   • Kill existing builds: bun kill:builds"
        echo "   • Or wait for builds to complete, then retry"
        echo ""
        exit 1  # Exit with error - prevent build collision
    fi
    exit 0
fi

# Interactive mode - prompt user to kill processes
echo ""
read -p "Kill these processes? (y/n): " -n 1 -r
echo ""

if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "🔪 Killing processes: $PIDS"
    for pid in $PIDS; do
        if kill $pid 2>/dev/null; then
            echo "  ✓ Killed PID $pid"
        else
            echo "  ✗ Failed to kill PID $pid (may have already exited)"
        fi
    done
    
    echo "⏳ Waiting for processes to terminate..."
    sleep 2
    echo "✅ Process cleanup complete"
else
    echo "❌ Processes left running - build may encounter conflicts"
    exit 1
fi
    echo "🔪 Killing processes: $PIDS"
    for pid in $PIDS; do
        if kill $pid 2>/dev/null; then
            echo "  ✓ Killed PID $pid"
        else
            echo "  ✗ Failed to kill PID $pid (may have already exited)"
        fi
    done
    
