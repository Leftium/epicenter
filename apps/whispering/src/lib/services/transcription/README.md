# Transcription Services

This directory organizes transcription providers (service implementations):

**`/cloud`**: API-based services that send audio to external providers. Require API keys and internet connection.

**`/self-hosted`**: Services that connect to servers you deploy yourself on your own machine. You provide the base URL of your own instance.

**Local engines (whispercpp / parakeet / moonshine)** do not have JS service files. Rust owns model loading, caching, and inference via the `transcribe_recording` Tauri command. Dispatch is inlined as one switch in `$lib/operations/transcribe.ts`, sharing the preflight + error mapping in `./local-transcription.ts`. Download catalogs live in `$lib/constants/local-models.ts`.
