# Transcription Services

This directory organizes transcription providers (service implementations):

**`/cloud`**: API-based services that send audio to external providers. Require API keys and internet connection.

**`/self-hosted`**: Services that connect to servers you deploy yourself on your own machine. You provide the base URL of your own instance.

**Local engines (whispercpp / parakeet / moonshine)** have no JS transcription services. Rust owns model loading, caching, and inference via the `transcribe_recording` Tauri command. Dispatch is inlined as one switch in `$lib/operations/transcribe.ts`, sharing the preflight in `./local-preflight.ts`. Download catalogs live in `$lib/constants/local-models.ts`; on-disk model storage (download, delete) lives in `./local-model-storage.ts`, orchestrated per model by `createPrebuiltModel` in `$lib/operations/local-models.ts`. Manually selected models are not a storage concern: `validateModelSelection` checks the chosen path and settings reference it in place, with no copy into appdata.
