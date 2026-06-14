---
'@epicenter/workspace': minor
---

Trim three zero-consumer exports off the public surface: `readMetadataFromPath` and `buildDaemonActions` leave the `./node` barrel (both stay as internal helpers), and `typedDispatch` / `TypedDispatch` leave the root barrel (the named `as` cast had no shipped consumer).
