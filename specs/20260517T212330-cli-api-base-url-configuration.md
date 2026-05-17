# CLI API Base URL Configuration

**Date**: 2026-05-17
**Status**: In Progress
**Author**: Braden + AI-assisted
**Branch**: (unstarted)

## One Sentence

The CLI's API base URL is `process.env.EPICENTER_API_URL` falling back to the embedded prod constant, each base URL owns its own token file at `~/.epicenter/auth[.<host>].json`, and named `bun run` scripts encode the two real workflows (prod, local).

## Overview

Today, `bun run packages/cli/src/bin.ts auth login` silently hits `https://api.epicenter.so` because `EPICENTER_API_URL` (in `@epicenter/constants/apps`) is the only source of truth for the base URL, and no command exposes a seam to override it. This spec adds one resolver, threads it through every command that talks to the API, and gives developers two named scripts (`cli`, `cli:local`) so the target is always explicit, not implicit.

## Motivation

### Current State

```ts
// packages/cli/src/commands/auth.ts
const result = await machineAuth.loginWithOob({
  print: (line) => console.log(line),
});                       // no baseURL passed; defaults to EPICENTER_API_URL
```

```ts
// packages/auth/src/node/machine-auth.ts
export async function loginWithOob({
  baseURL = EPICENTER_API_URL,    // already accepts baseURL, just isn't given one
  ...
}: LoginWithOobConfig = {}): Promise<...> { ... }
```

```ts
// packages/constants/src/apps.ts
APPS.API = { port: 8787, urls: ['https://api.epicenter.so'] };
export const EPICENTER_API_URL = APPS.API.urls[0];
```

```ts
// packages/auth/src/node/machine-tokens-store.ts (approx)
// Persists to ~/.epicenter/auth.json regardless of which baseURL signed in.
```

This creates problems:

1. **No seam to target local from the CLI**: A developer iterating on `apps/api/` cannot run `bun run packages/cli/src/bin.ts auth login` against their localhost API server without editing source.
2. **Implicit prod from source**: Source execution silently hits production. No flag, env var, or script names the target.
3. **Same-subject guard wipes the cell on environment switches**: `createOAuthAppAuth` wipes `~/.epicenter/auth.json` when the persisted subject differs from the one returned by `/api/me`. Logging in to localhost as a different account than the prod cell *destroys the prod tokens*. There is no per-host isolation.
4. **Daemon inherits the same blind spot**: `createMachineAuthClient` in `up.ts` startup also defaults to prod. `cli:local daemon up` would today still hit prod.

### Desired State

```bash
# Daily local-API development
bun run cli:local auth login
bun run cli:local daemon up

# From-source against prod (rare but valid: CLI bug repro, demos)
bun run cli auth login

# End-user installed binary (unchanged)
epicenter auth login

# Override anywhere
EPICENTER_API_URL=https://staging.epicenter.so bun run cli auth login
```

```ts
// packages/cli/src/util/api-url.ts (new)
import { homedir } from 'node:os';
import { join } from 'node:path';
import { EPICENTER_API_URL } from '@epicenter/constants/apps';

const PROD_HOST = new URL(EPICENTER_API_URL).host;

export function resolveApiEndpoint(): { baseURL: string; filePath: string } {
  const fromEnv = process.env.EPICENTER_API_URL;
  const raw = (fromEnv ?? EPICENTER_API_URL).replace(/\/$/, '');
  if (!URL.canParse(raw)) {
    throw new Error(`EPICENTER_API_URL is not a valid URL: ${raw}`);
  }
  // stderr log once per process when env var is set
  const { host } = new URL(raw);
  const slug = host === PROD_HOST
    ? 'auth.json'
    : `auth.${host.replace(':', '_')}.json`;
  return { baseURL: raw, filePath: join(homedir(), '.epicenter', slug) };
}
```

```ts
// every command that talks to the API:
const { baseURL, filePath } = resolveApiEndpoint();
await machineAuth.loginWithOob({ baseURL, filePath, print: ... });
```

**Note on shape**: an earlier draft of this spec had `resolveApiBaseURL()` and `authFilePathFor(baseURL)` as two separate functions. The implementation collapsed them into one `resolveApiEndpoint()` returning `{ baseURL, filePath }`: every caller wants both, one URL parse suffices, and `authFilePathFor` had no standalone consumer. `URL.canParse` replaces the prior `try { new URL } catch` and `PROD_HOST` is hoisted to module scope.

## Research Findings

### Existing baseURL plumbing in `@epicenter/auth/node`

Already complete. Each function in `packages/auth/src/node/machine-auth.ts` accepts `baseURL` via `CommonConfig`, derives the OAuth `redirectUri` as `` `${baseURL}/auth/cli-callback` `` (machine-auth.ts:110), derives the `/api/me` URL from `baseURL` (machine-auth.ts:335), and passes `baseURL` to `createOAuthAppAuth` so the token-refresh path also uses it (machine-auth.ts:300). The CLI just never supplies a value.

`CommonConfig` also accepts `filePath`, which `saveMachineTokens` / `loadMachineTokens` honor. Per-host file derivation is a CLI concern; the auth package is already parameterized.

**Implication**: No changes required in `@epicenter/auth`. The whole feature lives in `packages/cli/`.

### Vite-mode pattern for browser apps (rejected for CLI)

Browser apps in this repo flip between `http://localhost:<port>` (Vite `dev` mode) and `app.urls[0]` (Vite `prod`). This is a Vite-only mechanism: the CLI is a Bun process, not a Vite app. Detecting "running from source" via `import.meta` or `NODE_ENV` would tie *transport* to *runtime*, which the user explicitly rejected.

### How other CLIs handle dev vs prod targeting

| Tool | Mechanism | Notes |
| --- | --- | --- |
| `gh` (GitHub CLI) | `GH_HOST` env var + `--hostname` flag | Per-host config and per-host token. |
| `vercel` | `VERCEL_URL` + `--scope` + interactive config | Heavy: full config file, multiple scopes. |
| `supabase` | `SUPABASE_URL` env var (no flag for base) | Env-var-only; pragmatic. |
| `clerk` | Build-time injected publishable key | Different model (per-app keys, not env switching). |
| `stripe` | API key implies environment (test vs live key) | Auth medium *is* the environment selector. |

**Key finding**: Env var is the lowest-friction option that does not require a config file. `gh`'s per-host token isolation is the precedent for `auth.<host>.json`.

**Implication**: Env var with per-host token file matches industry pattern. Avoid flags and config files; they are not load-bearing here.

## Design Decisions

| Decision | Class | Choice | Rationale |
| --- | --- | --- | --- |
| Configuration mechanism | 3 taste | Env var `EPICENTER_API_URL` only | Matches `supabase` and `gh` defaults; one source of truth; no flag duplication. |
| `--api-url` flag | 2 coherence | Refuse | Asymmetric-wins refusal. Adds yargs surface, threads through every handler and daemon boot, duplicates env var. Removed for zero user loss. |
| Implicit dev-mode detection | 2 coherence | Refuse | Ties transport to runtime; conflates "I am developing the CLI" with "I am developing the API." User explicitly rejected. |
| Default when env var unset | 3 taste | Fall back to prod constant | Matches installed-binary behavior; raw `bun src/bin.ts` defaults to prod. Devs use named scripts for local. |
| Token file naming | 1 evidence | `auth.json` for prod host; `auth.<host>.json` otherwise | Verified `CommonConfig.filePath` flows through `saveMachineTokens`/`loadMachineTokens`. Backwards compatible (prod cell stays at canonical path). Removes same-subject wipe foot-gun. |
| Where the resolver lives | 2 coherence | `packages/cli/src/util/api-url.ts` | `@epicenter/auth/node` is environment-agnostic; resolution is a CLI policy. Same package as `common-options.ts`. |
| `dev`/`cli:local` script location | 3 taste | `packages/cli/package.json` AND root `package.json` | Devs run from both. Mirroring is two duplicate lines but removes friction. |
| Daemon scope | 2 coherence | Include in this spec | `cli:local daemon up` must hit local API; otherwise the script lies. |
| Lifecycle: re-read env mid-process | 2 coherence | No, freeze at boot | One read in each entrypoint; retarget = restart. Matches the daemon's lifecycle model. |

## Architecture

```
+----------------------------------------------------------+
| shell environment                                        |
|   EPICENTER_API_URL=http://localhost:8787   (optional)   |
+----------------------------------------------------------+
                            | process.env
                            v
+----------------------------------------------------------+
| packages/cli/src/util/api-url.ts                         |
|   resolveApiEndpoint() => { baseURL, filePath }           |
+----------------------------------------------------------+
                            | called once per command
                            v
+----------------------------------------------------------+
| auth.ts handlers           up.ts startup                  |
|   loginWithOob({ baseURL, filePath, ... })                |
|   status({ baseURL, filePath, ... })                      |
|   logout({ baseURL, filePath, ... })                      |
|   createMachineAuthClient({ baseURL, filePath, ... })     |
+----------------------------------------------------------+
                            | already-existing plumbing
                            v
+----------------------------------------------------------+
| @epicenter/auth/node                                     |
|   derives /api/me URL, redirectUri, refresh URL from base |
|   reads/writes token file at the path given               |
+----------------------------------------------------------+
```

### File ownership matrix

```
process env                shell or `bun run <script>`
default URL                @epicenter/constants/apps (unchanged)
URL resolution             packages/cli/src/util/api-url.ts (new)
file path derivation       packages/cli/src/util/api-url.ts (new)
threading to auth pkg      packages/cli/src/commands/{auth,up}.ts
on-disk token storage      ~/.epicenter/auth[.<host>].json
```

## Implementation Plan

### Phase 1: URL resolver and per-host file derivation

- [ ] **1.1** Create `packages/cli/src/util/api-url.ts` with `resolveApiEndpoint()`. Validate the URL parses; throw with the offending value in the message.
- [ ] **1.2** Unit test `packages/cli/src/util/api-url.test.ts`: env var absent (returns prod), env var set (returns it), env var malformed (throws), prod host returns `auth.json`, non-prod host returns `auth.<host>.json` with `:` replaced.

### Phase 2: Thread through commands

- [ ] **2.1** `packages/cli/src/commands/auth.ts`: each of `login`, `status`, `logout` calls `resolveApiEndpoint()`, then passes `{ baseURL, filePath }` into the corresponding `machineAuth.*` call.
- [ ] **2.2** `packages/cli/src/commands/up.ts`: read both at boot, pass into `createMachineAuthClient`. Freeze the value; do not re-read.
- [ ] **2.3** Grep `packages/cli/src` for any other call to `@epicenter/auth/node` and apply the same pattern. (Today there should be none beyond the above; verify.)

### Phase 3: Scripts

- [ ] **3.1** `packages/cli/package.json`: add `"cli": "bun src/bin.ts"` and `"cli:local": "EPICENTER_API_URL=http://localhost:8787 bun src/bin.ts"` to `scripts`.
- [ ] **3.2** Root `package.json`: add `"cli": "bun packages/cli/src/bin.ts"` and `"cli:local": "EPICENTER_API_URL=http://localhost:8787 bun packages/cli/src/bin.ts"` to `scripts`. Confirm no naming collision.

### Phase 4: Docs

- [ ] **4.1** `packages/cli/README.md`: add a "Targeting an environment" section above "Commands" with the four-row table (Local API / Prod from source / Installed binary / One-off override), and a one-paragraph note on `~/.epicenter/auth.<host>.json` per-host isolation.
- [ ] **4.2** Root `README.md`: add a short subsection under whatever section covers contributing / local dev that says "to develop against a local API server, use `bun run cli:local`, see `packages/cli/README.md`."

### Phase 5: Verify

- [ ] **5.1** `bun run typecheck` (or repo-wide equivalent).
- [ ] **5.2** `bun test packages/cli`.
- [ ] **5.3** Manual smoke: `bun run cli:local auth login` against a local API on `:8787`, then `bun run cli auth login` against prod with a different account. Verify both `auth.json` and `auth.localhost_8787.json` exist and neither was wiped.

## Edge Cases

### IPv6 / unusual hosts in `EPICENTER_API_URL`

1. `EPICENTER_API_URL=http://[::1]:8787` parses to `URL.host` of `[::1]:8787`; after `:` replacement it becomes `[::1]_8787` (only the *last* `:` is replaced; `replace(':', '_')` is single-occurrence).
2. **Decision**: Acceptable filename for the rare IPv6 dev case. If it bites, swap for `.replaceAll(':', '_')` in `resolveApiEndpoint`.

### Trailing slash in `EPICENTER_API_URL`

1. `EPICENTER_API_URL=http://localhost:8787/` parses fine, but `${baseURL}/auth/cli-callback` produces a double slash.
2. **Decision**: Resolver normalizes by stripping a single trailing slash before returning. Belt-and-suspenders: the auth package should be robust to either, but the resolver is the right place to canonicalize.

### Prod URL constant changes in the future

1. `EPICENTER_API_URL` constant changes to, say, `https://api.v2.epicenter.so`.
2. Existing `~/.epicenter/auth.json` was written against the *old* prod host but `resolveApiEndpoint` would now think the new host is canonical and read `auth.json` anyway. This is fine: the same-subject guard inside `createOAuthAppAuth` will wipe it correctly on first login to the new host, and the user re-authenticates.
3. **No special handling needed.**

### User sets `EPICENTER_API_URL` to the prod URL explicitly

1. `EPICENTER_API_URL=https://api.epicenter.so bun run cli auth login` returns `auth.json` (matches prod host). Identical to the default-fallback case.

### Daemon started with one env var, retargeted via re-export

1. User exports a new `EPICENTER_API_URL` after `daemon up`.
2. **Behavior**: The running daemon keeps the boot-time URL. To switch, the user must `daemon down` and `daemon up` again.
3. **Decision**: Correct. Mid-process retarget is not a supported workflow; documenting this in the daemon section of the README is sufficient.

## Open Questions (resolved)

1. **Duplicate scripts in root and `packages/cli`?** **Resolved: yes.** Both `cli` and `cli:local` live in root `package.json` AND `packages/cli/package.json`. Two lines of duplication beats the cognitive cost of "where am I when I run this."

2. **Host-only vs scheme+host in token filename?** **Resolved: host only.** `auth.<host>.json` where `host` is `new URL(baseURL).host`. The same-subject guard already protects against scheme collisions in the contrived dual-scheme case.

3. **Log resolved URL at startup?** **Resolved: yes, but only when the env var is set.** Print `Using API at <url>.` to stderr from `resolveApiEndpoint()` when `process.env.EPICENTER_API_URL` is defined (regardless of whether it equals the default constant). Silent when unset. Log once per process; guard with a module-level boolean so repeated calls don't print twice.

## Decisions Log

- **Keep `EPICENTER_API_URL` as the env var name**: constraint = it is already the constant name; matching the var name removes friction.
  Revisit when: the constant is renamed for reasons unrelated to this feature.
- **Keep `~/.epicenter/auth.json` as the prod filename (not `auth.api_epicenter_so.json`)**: constraint = backwards compatibility for existing signed-in users.
  Revisit when: a migration is acceptable and per-host symmetry becomes important.

## Success Criteria

- [ ] `bun run cli:local auth login` (from repo root) targets `http://localhost:8787`.
- [ ] `bun run cli auth login` (from repo root) targets `https://api.epicenter.so`.
- [ ] `bun run cli:local daemon up` boots a daemon that talks to local API.
- [ ] After local login, `~/.epicenter/auth.localhost_8787.json` exists; existing `~/.epicenter/auth.json` (if any) is untouched.
- [ ] After switching back to prod login, both files coexist with their respective subjects.
- [ ] `packages/cli/README.md` contains the four-row environment table.
- [ ] Root `README.md` references `bun run cli:local` for local API development.
- [ ] `bun test packages/cli` passes including new `api-url.test.ts`.
- [ ] No new yargs flag added; no new config file added.

## References

- `packages/cli/src/commands/auth.ts`: three handlers that need `{ baseURL, filePath }` threaded in.
- `packages/cli/src/commands/up.ts`: startup that needs the same.
- `packages/auth/src/node/machine-auth.ts:92,165,246,279`: `loginWithOob`, `status`, `logout`, `createMachineAuthClient` already accept `baseURL` and `filePath`.
- `packages/auth/src/node/machine-tokens-store.ts`: honors `filePath`.
- `packages/constants/src/apps.ts`: `EPICENTER_API_URL` prod constant (unchanged).
- `packages/cli/src/util/common-options.ts`: sibling pattern for shared CLI utilities (file shape to mirror).
- `packages/cli/package.json`, root `package.json`: script additions.
- `packages/cli/README.md`, root `README.md`: docs.
