# Epicenter

Local-first workspace platform. Monorepo with Yjs CRDTs and Svelte UI.

Structure: `apps/whispering/` (Tauri transcription app), `apps/tab-manager/` (Chrome extension), `apps/api/` (hosted personal Cloud Worker: `worker/` + `ui/`), `apps/self-host/` (self-hosted shared wiki reference Worker), `packages/server/` (shared Hono library that both deployables consume; `personal()` + `shared({ admit })` seam), `packages/workspace/` (core TypeScript/Yjs library), `packages/cli/` (published CLI package and `epicenter` binary), `packages/ui/` (shadcn-svelte components), `specs/` (planning docs), `docs/` (reference materials).

Planning docs and decisions: Authoritative sources, in order, are `docs/adr/` (durable decisions and their rationale), `docs/CONTEXT.md` (shared vocabulary), and `docs/reference/` plus the code (current state). Specs in any `specs/` directory (top-level and per-app or per-package) are in-flight design scaffolding, not current truth; the two-state lifecycle and hygiene gate govern all of them repo-wide. `docs/spec-history.md` is a dated index of past specs and is history, not truth. When a spec conflicts with an ADR or the code, the ADR and code win. A spec has only two states, `Draft` and `In Progress`; "done" is deletion, not a terminal status, so a spec still in the tree declaring `Implemented`/`Superseded` is a hygiene smell (`scripts/check-doc-hygiene.ts` flags it). When a design pass settles a durable decision, record it as an ADR (see `docs/adr/README.md`) and delete the now-spent spec; git keeps the body recoverable.

Deployment seam: One library (`packages/server`), two deployables (`apps/api` = hosted personal cloud, `apps/self-host` = self-hosted shared wiki reference). Billing (catalog, routes, Autumn) lives in `apps/api/worker/billing/` and is hosted-only; never extract it back to a shared package. The self-hosted shared-wiki deployable is community-supported, not Epicenter-operated.

Always use bun: Prefer `bun` over npm, yarn, pnpm, and node. Use `bun run`, `bun test`, `bun install`, and `bun x` (instead of npx).

Agent instruction files: Treat `AGENTS.md` as the canonical shared instructions file. `CLAUDE.md` files are compatibility shims for Claude Code and should only import a sibling `AGENTS.md` with `@AGENTS.md`, plus rare Claude-specific notes if needed. When adding a nested `AGENTS.md`, add a sibling `CLAUDE.md` shim. Do not create orphan `CLAUDE.md` files.

Destructive actions need approval: Force pushes, hard resets (`--hard`), branch deletions.

External grounding: When external library behavior affects correctness, verify against DeepWiki, official docs, or local installed types before changing code. Skip this for stable basics and repo-local patterns already documented in skills.

Git hygiene: Stage specific files only. Never use `git add .` or `git add -A`. Do not include AI or tool attribution in commits.

Review posture: Be direct about flawed assumptions, weak designs, and regressions. Do not agree just to be agreeable.

Script suffix convention: `:local` suffix scripts work on a fresh clone without Infisical login (they read committed config like `wrangler.jsonc`). `:remote` suffix scripts wrap with `infisical run --env=prod` and require Infisical authentication; treat them as production admin operations.

Library logging: Do not use direct `console.*` in library code. Use `wellcrafted/logger`, except in CLIs, tests, and benchmarks.

Writing conventions: Load `writing-voice` skill for any user-facing text or punctuation-sensitive prose (UI strings, tooltips, error messages, docs, comments, JSDoc, markdown, and commit messages). Default to colon, comma, semicolon, parenthesis, or sentence break over em dash characters (`U+2014`), especially in UI strings. Do not use en dash characters (`U+2013`).

Review gates: For substantial implementations, public API changes, refactors, multi-file changes, or user requests to grill, simplify, or clean up the result, load `post-implementation-review` before final handoff or staging. Load `collapse-pass` directly for continuous indirection-reduction work. During review, escalate to `cohesive-clean-breaks` for ownership, lifecycle, API, package-boundary, or asymmetric-win decisions, and to `greenfield-clean-breaks` when compatibility is not load-bearing or the user asks for the ideal shape. Keep procedures in skills; keep `AGENTS.md` to routing.
