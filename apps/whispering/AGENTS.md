# Whispering App

Tauri + Svelte 5 desktop/web app for voice transcription.

## Key Points

- Three-layer architecture: Service → Query → UI
- Services are pure functions returning `Result<T, E>`
- Build-time platform DI via `.tauri.ts` / `.browser.ts` suffix files (see `vite.config.ts`'s `resolve.extensions`)
- Tauri-only capabilities live in `$lib/tauri.tauri.ts` and consumers check `if (tauri)` (the variable doubles as the platform boolean)
- Query layer handles reactivity, caching, and error transformation
- See `ARCHITECTURE.md` for detailed patterns

## Don'ts

- Don't put business logic in Svelte components
- Don't access settings directly in services (pass as parameters)
- Don't use try-catch; use wellcrafted Result types

## Tauri Commands

Every Tauri command is registered through `make_specta_builder()` in
`src-tauri/src/lib.rs` and consumed by the frontend through the boundary
adapter at `src/lib/tauri/commands.ts`. To add a command:

1. Decorate the Rust function with both attributes:
   ```rust
   #[tauri::command]
   #[specta::specta]
   pub async fn my_command(...) -> Result<MyOutput, MyError> { ... }
   ```
2. Derive `specta::Type` on any custom argument/return types.
3. Add the function to the `collect_commands!` list in `make_specta_builder`.
4. Regenerate: `bun run --cwd apps/whispering bindings:tauri`.
5. Call from TS: `import { commands } from '$lib/tauri/commands'`.

Raw-byte commands (`tauri::ipc::Response::new(bytes)` return) cannot be
specta-typed; mount them through a separate `generate_handler!` in `lib.rs`
and hand-roll the JS wrapper in `commands.ts`. Today the only one is
`encode_recording_for_upload`.

The boundary file is the only place in `src/lib/**` that may import
`invoke` from `@tauri-apps/api/core` for app commands. Tauri plugin APIs
(fs, shell, clipboard, etc.) keep their own imports.

## Specs and Docs

- App-specific specs: `./specs/`
- App-specific docs: `./docs/` (if needed)
- Cross-cutting specs: `/specs/`
- Cross-cutting docs: `/docs/`

See root `AGENTS.md` for the full organization guide.
