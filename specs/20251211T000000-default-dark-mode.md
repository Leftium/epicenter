# Default Dark Mode Implementation

## Problem

Currently, Whispering respects the system preference for light/dark mode via the `mode-watcher` library. The goal is to make dark mode the default, ignoring system settings.

## Rationale

Dark mode is the canonical way to use Whispering. The app's visual identity and design language are centered around the dark theme.

## Current Implementation

In `/apps/whispering/src/routes/+layout.svelte`, the `ModeWatcher` component is initialized without any props:

```svelte
<ModeWatcher />
```

This defaults to tracking the system preference and using that as the initial mode.

## Solution

The `mode-watcher` library supports two relevant props:

1. **`defaultMode`** - Sets the initial theme ("light", "dark", or "system")
2. **`track`** - Whether to track system preference changes (boolean)

To make dark mode the default and ignore system settings:

```svelte
<ModeWatcher defaultMode="dark" track={false} />
```

## Implementation Steps

- [ ] Update `ModeWatcher` in `+layout.svelte` to use `defaultMode="dark"` and `track={false}`

## File to Modify

- `/apps/whispering/src/routes/+layout.svelte` (line 57)

## Notes

- Users can still toggle the theme manually via the light switch button
- The preference will be stored in localStorage after first toggle
- Setting `track={false}` prevents the app from switching themes when the OS preference changes
