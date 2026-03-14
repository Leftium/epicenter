# Epicenter

Local-first workspace platform. Monorepo with Yjs CRDTs and Svelte UI.

Structure: `apps/whispering/` (Tauri transcription app), `apps/tab-manager/` (Chrome extension), `apps/api/` (Cloudflare hub), `packages/workspace/` (core TypeScript/Yjs library), `packages/ui/` (shadcn-svelte components), `specs/` (planning docs), `docs/` (reference materials).

Always use bun: Prefer `bun` over npm, yarn, pnpm, and node. Use `bun run`, `bun test`, `bun install`, and `bun x` (instead of npx).

Destructive actions need approval: Force pushes, hard resets (`--hard`), branch deletions.

Token-efficient execution: When possible, delegate to sub-agent with only the command. Instruct it to execute without re-analyzing.

Writing conventions: Load `writing-voice` skill for any user-facing text—UI strings, tooltips, error messages, docs. Em dashes are always closed (no spaces).

Content model: Document content uses the timeline model (`Y.Array('timeline')`). Use `handle.content.read()`/`handle.content.write()` for text, `handle.content.getText()` for editor binding, and `handle.content.timeline` for advanced operations. Never access `handle.ydoc.getText('content')` directly—use `handle.content` instead. See `specs/20260313T230000-promote-timeline-to-workspace.md`.
