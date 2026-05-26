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

## Specs and Docs

- App-specific specs: `./specs/`
- App-specific docs: `./docs/` (if needed)
- Cross-cutting specs: `/specs/`
- Cross-cutting docs: `/docs/`

See root `AGENTS.md` for the full organization guide.
