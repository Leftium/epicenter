# Atomic File Writes with Temp + Rename

When you write to a file, there's a window where the file is partially written. If your process crashes, or another process reads during that window, you get corrupted or incomplete data.

The fix: write to a temporary file, then rename it to the final path. On most filesystems, rename is atomic.

## The Problem

```typescript
// BROKEN: Reader can see partial file
await writeFile('config.json', JSON.stringify(config));
```

If the write fails halfway through, `config.json` contains garbage. If another process reads during the write, it gets incomplete JSON.

## The Pattern

```typescript
const tmpPath = `${filePath}.tmp`;

// Write to temp file
await writeFile(tmpPath, content);

// Atomic rename to final location
await rename(tmpPath, filePath);
```

The rename operation is atomic on POSIX filesystems (Linux, macOS) and NTFS (Windows). Either the old file exists, or the new file exists. Never partial content.

## Real Example: Markdown Persistence

```typescript
async function saveRecording(recording: Recording) {
  const mdPath = `recordings/${recording.id}.md`;
  const tmpPath = `${mdPath}.tmp`;

  const mdContent = matter.stringify(recording.transcribedText, {
    id: recording.id,
    title: recording.title,
    timestamp: recording.timestamp,
  });

  // Write to temp file first
  await writeTextFile(tmpPath, mdContent);

  // Atomic rename
  await rename(tmpPath, mdPath);
}
```

If the write fails, `recordings/abc123.md` is untouched. If another process reads during the operation, it gets the old complete file, not a partial new one.

## Cleanup on Failure

If you want to be thorough, clean up the temp file on write failure:

```typescript
try {
  await writeFile(tmpPath, content);
  await rename(tmpPath, filePath);
} catch (error) {
  // Clean up temp file if it exists
  await unlink(tmpPath).catch(() => {});
  throw error;
}
```

In practice, orphaned `.tmp` files are harmless and often get cleaned up on next successful write or app startup.

## When Rename Isn't Atomic

Rename is only atomic when source and destination are on the same filesystem. If you're writing across mount points or drives, you need a different strategy (copy + delete, which isn't atomic).

For app data directories, you're almost always on the same filesystem, so this isn't usually a concern.

## The Rule

Never write directly to the final file path. Write to a `.tmp` file in the same directory, then rename. Your readers will never see partial content.
