# 0084. Super Chat's tools load as vendored TypeScript via Bun's native dynamic import; its shell is a Bun-hosted local server, not a bundled SPA

- **Status:** Proposed (the loading mechanism and shell-packaging shape are settled; third-party delivery via jsrepo is named but not built, and the packaging shape is not yet prototyped)
- **Date:** 2026-06-30
- **Relates:** [ADR-0080](0080-the-super-app-is-a-desktop-host-cross-device-is-remote-access-to-the-session-not-a-per-app-capability-plane.md) (the super app is a desktop host composing local surfaces; this settles how it loads them and how its shell is packaged), [ADR-0073](0073-tools-speak-mcp-natively-epicenter-owns-only-the-transport-mcp-lacks.md) (MCP is for foreign hosts), [ADR-0081](0081-per-upstream-oauth-concurrency-decides-mirror-topology.md) (the one remaining reason an app needs MCP: an upstream forces box-only ownership), [ADR-0066](0066-runtime-portability-is-per-concern-injection-not-a-runtime-object.md) (names the `bun build --compile` self-host binary plus Tauri sidecar shape this decision realizes)

## Context

ADR-0080 settled that the super app is a single desktop host composing local app surfaces: in-process action registries for user-curated Yjs apps (arm A), local stdio MCP verb facades for apps an upstream forces to be box-owned (arm B, Local Books today). Two questions were left open under that decision: how does the host load a given app's tool code, especially code that doesn't already live in this monorepo, and how does its Tauri shell present it, bundle a static SPA the ordinary Tauri way, or something else.

Grounded directly against opencode (`sst/opencode`) and jsrepo (`jsrepojs/jsrepo`). Opencode loads TypeScript plugins with a plain directory scan (`.opencode/plugins/*.ts`, matched via `Glob.scan`) plus Bun's native `import()` of the raw `.ts` files: no bundler, no MCP, no manifest beyond the directory convention itself. Loaded plugins run with full ambient trust, the same privileges as the host process, no sandbox. jsrepo is a source-copier, the same model as shadcn/ui's CLI, not a package manager: `jsrepo add` is a one-time explicit fetch that writes raw source to a path you own and commit. It has no version-pinning mechanism of its own; reproducibility, if wanted, comes only from your own commit discipline. This monorepo's own jsrepo producer registry is currently broken, pointing at deleted paths.

Separately, ADR-0081 already narrowed MCP's justification to exactly one case: an upstream's own OAuth/connection policy forecloses per-device materialization (Local Books, forced box-owned by Intuit's one-connection-per-realm-per-app limit). That is not a property of tool-composition in general, so it does not motivate a broader role for MCP inside the super app.

On packaging: Tauri's own default deliberately avoids serving app content over a localhost HTTP server, using custom schemes (`tauri://localhost`) instead, specifically to sidestep the risk class that comes with a real, network-reachable local port. Grounded against Tauri's docs and source directly: pointing a production `WebviewWindow` at a runtime-determined `http://localhost:PORT` is supported (`WebviewUrl::External`, `WebviewWindow::navigate`, sidecar port discovery via `CommandEvent::Stdout` from the shell plugin's sidecar `Command`), but is an assembled pattern from separate primitives, not an official recipe, and Tauri provides no built-in authentication for that shape. Any protection has to live in the sidecar server itself.

## Decision

**Loading is settled and delivery-agnostic.** The host process loads tool code with a plain directory scan of `.ts` files plus Bun's native `import()`, the same mechanism opencode already uses. No MCP, no bundler, no compile step, for anything that runs in-process.

**Delivery is a separate axis, and only half of it is settled today:**

- **First-party tools** (Whispering, opensidian, Local Mail, any other Epicenter-owned app) are ordinary monorepo package imports, exactly how `composeToolCatalogs` / `createLocalToolCatalog` already work. jsrepo is not involved; these are already packages Epicenter owns and builds.
- **Third-party tools** are the case jsrepo is actually for, and this ADR does not settle that path as production-ready. `jsrepo add` writes ordinary committed source to disk, so once installed a block is no different from hand-written code, but jsrepo carries no lockfile of its own, and a tool file loaded this way runs with the same full ambient trust as first-party code, no sandbox. Third-party delivery via jsrepo is a **named, deferred** path: earned when a live third-party tool source exists, not built now. It is not decided infrastructure until a pinning, review-gate, or sandboxing story is designed alongside it.

**MCP stays exactly as narrow as ADR-0081 already made it.** Reserved for apps an upstream forces to be box-owned, never a general tool-composition path.

**The shell is a Bun-hosted local server, not a bundled static SPA.** Super Chat's Tauri shell spawns a Bun sidecar binary (`bun build --compile`, the artifact already named in ADR-0066) that runs its own HTTP server (`Bun.serve`), serving both the SPA's static assets and its `/api` / `/ws` surface. The Tauri window is created against that server's URL (`WebviewUrl::External`) instead of the bundled `frontendDist`. This reuses the runtime shape `packages/server` / `apps/self-host` already run, rather than inventing a second packaging story for one app.

**This shape carries a mandatory security consequence, not an optional hardening pass**, because Tauri provides no protection for it by default:

- The sidecar binds `127.0.0.1` only (`Bun.serve({ hostname: "127.0.0.1", port: 0 })`), never a LAN-reachable interface. Port `0` lets the OS assign a free ephemeral port; Rust discovers it from the sidecar's stdout via the existing Tauri `CommandEvent::Stdout` sidecar pattern.
- Rust generates a fresh, random, per-launch token at each app start, never persisted to disk, and hands it to the sidecar over stdin, not argv (visible to any same-user process via `ps`).
- The window's initial URL carries the token once (`http://127.0.0.1:<port>/?token=<token>`, the mechanism Jupyter uses for its own local server). The SPA reads it once into an in-memory variable, never `localStorage`, and attaches it to every subsequent request: an `Authorization: Bearer` header for `fetch` calls, and a query parameter or cookie for WebSocket connections, since the browser `WebSocket` constructor cannot set custom headers and the bearer-header approach only covers HTTP.
- Every request without a valid token is rejected before any tool executes, mutating or not. This is the actual boundary between this app's own window and any other process on the same machine; a loopback bind alone only stops other machines, not other local processes, and what sits behind the port is a process with full ambient trust to invoke tools, including whatever reaches Local Books' data.

## Consequences

- The "arm A default, MCP as the narrow exception" design from ADR-0080/0081 is unchanged. This ADR settles the concrete loading mechanism and is explicit about which half of delivery is decided (first-party) versus named-but-deferred (third-party via jsrepo).
- The desktop host now has a concrete runtime target: a `bun build --compile` binary is both the self-host server artifact (ADR-0066) and the Super Chat sidecar, so building one is progress on both.
- The loopback-plus-token pair must ship with the sidecar's first version, not be bolted on later, since Local Books' data is reachable through it the moment the sidecar exists.
- Third-party jsrepo delivery remains explicitly unbuilt. Anyone picking this up later should not read "jsrepo" as settled infrastructure; its trust and pinning story is an open design question, not an oversight.
- Super Chat diverges from Whispering / Matter / Fuji's current Tauri packaging (bundled `frontendDist`). This is a deliberate, scoped divergence for one app, not a monorepo-wide shell migration.

## Considered alternatives

- **MCP (stdio or local) as the general tool-loading mechanism for arm A.** Rejected: MCP is a protocol for foreign hosts (ADR-0073); wrapping first-party, same-process TypeScript in a protocol boundary it doesn't need adds handshake and serialization cost for no isolation benefit, since the code still runs with full ambient trust either way.
- **jsrepo for all tool delivery, first-party included.** Rejected for now: first-party tools are already monorepo packages; routing them through a source-copier adds an install step and a reproducibility gap, no jsrepo-native lockfile, for zero benefit over a plain workspace import.
- **Electrobun, or another Bun-native shell, instead of Tauri plus sidecar.** Rejected: solves a problem this design doesn't have, since Bun does not need to own the window to do native dynamic tool loading, at the cost of walking away from proven, working Tauri packaging, signing, and update infrastructure already shared across three apps, for an ecosystem that just reached v1.
- **Tauri's default bundled `frontendDist` plus a separate local-IPC channel, a Unix socket, to the Bun sidecar for tool calls.** Rejected in favor of one unified Bun-hosted server: two systems, a static bundle plus a bespoke IPC protocol, is more moving parts than one Bun process serving both the page and its own API, for no isolation or security benefit; the IPC channel would need the same trust boundary the token already provides here.
