# Transcription Services

This directory organizes transcription providers (service implementations):

**`/cloud`**: API-based services that send audio to external providers. Require API keys and internet connection.

**`/self-hosted`**: Services that connect to servers you deploy yourself on your own machine. You provide the base URL of your own instance.

**Local engines (whispercpp / parakeet / moonshine)** have no JS transcription services. Rust owns model loading, caching, and inference via the `transcribe_recording` Tauri command. Dispatch is inlined as one switch in `$lib/operations/transcribe.ts`. The engine's models folder under appdata is the single source of truth: catalog downloads land in it, and users add their own models by dropping or symlinking them into it. Settings store a folder entry name, never a path; Rust resolves and validates the name against its models directory at load time, so a path never exists as data anywhere. `./local-model-folder.ts` owns the JS view of the folder (discovery, download, delete). Download catalogs live in `$lib/constants/local-models.ts`, with the shared per-engine folder store (disk state plus in-flight downloads) in `$lib/state/model-folder.svelte.ts`.
