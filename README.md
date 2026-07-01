<p align="center">
  <a href="https://epicenter.so">
    <img width="200" src="https://github.com/user-attachments/assets/9e210c52-2740-43b6-af3f-e6eaf4b5c397" alt="Epicenter">
  </a>
  <h1 align="center">Epicenter</h1>
  <p align="center"><strong>Local-first apps that write to files you own.</strong></p>
  <p align="center">Your data lives on your machine as plain Markdown and SQLite: grep it, version it, open it in Obsidian. When an app stops mattering, your files don't.</p>
  <p align="center">Start with <a href="apps/whispering">Whispering</a>, our desktop speech-to-text app. You can install it today.</p>
  <p align="center">Run the apps freely under AGPL-3.0; build on the developer toolkit freely under MIT. <a href="#license">What that means</a>.</p>
</p>

<p align="center">
  <a href="https://github.com/EpicenterHQ/epicenter" target="_blank">
    <img alt="GitHub stars" src="https://img.shields.io/github/stars/EpicenterHQ/epicenter?style=flat-square" />
  </a>
  <a href="https://github.com/EpicenterHQ/epicenter/releases/latest" target="_blank">
    <img alt="Latest release" src="https://img.shields.io/github/v/release/EpicenterHQ/epicenter?style=flat-square&label=Latest%20Release&color=brightgreen" />
  </a>
  <a href="#license">
    <img alt="Apps license: AGPL-3.0" src="https://img.shields.io/badge/apps-AGPL--3.0-blue?style=flat-square" />
  </a>
  <a href="#license">
    <img alt="Toolkit license: MIT" src="https://img.shields.io/badge/toolkit-MIT-brightgreen?style=flat-square" />
  </a>
  <a href="https://go.epicenter.so/discord" target="_blank">
    <img alt="Discord" src="https://img.shields.io/badge/Discord-Join%20us-5865F2?style=flat-square&logo=discord&logoColor=white" />
  </a>
  <a href="https://github.com/EpicenterHQ/epicenter/releases" target="_blank">
    <img alt="macOS" src="https://img.shields.io/badge/-macOS-black?style=flat-square&logo=apple&logoColor=white" />
  </a>
  <a href="https://github.com/EpicenterHQ/epicenter/releases" target="_blank">
    <img alt="Windows" src="https://img.shields.io/badge/-Windows-blue?style=flat-square&logo=windows&logoColor=white" />
  </a>
  <a href="https://github.com/EpicenterHQ/epicenter/releases" target="_blank">
    <img alt="Linux" src="https://img.shields.io/badge/-Linux-yellow?style=flat-square&logo=linux&logoColor=white" />
  </a>
</p>

<p align="center">
  <a href="#install-whispering">Install</a> |
  <a href="#build-with-the-toolkit">Toolkit</a> |
  <a href="#how-it-works">How It Works</a> |
  <a href="#status">Status</a> |
  <a href="#trust-boundaries">Trust</a> |
  <a href="#repo-map">Repo Map</a> |
  <a href="#development">Development</a> |
  <a href="#license">License</a>
</p>

---

## Install Whispering

[Whispering](apps/whispering) is Epicenter's desktop speech-to-text app for macOS, Windows, and Linux.

```bash
brew install --cask whispering
```

On Windows and Linux, download the installer from the [latest release](https://github.com/EpicenterHQ/epicenter/releases/latest).

Press a shortcut, speak, optionally transform the transcript, and paste the result where you were working. No Epicenter account is required. You can run local Whisper C++ for offline transcription, or bring your own API key for providers like Groq, OpenAI, and ElevenLabs.

[Install Whispering](apps/whispering#install-whispering) | [Download latest release](https://github.com/EpicenterHQ/epicenter/releases/latest)

## Build With The Toolkit

The developer toolkit is MIT: build anything on it, including closed-source and commercial products, and you own what you build, with no obligation back to Epicenter. These are the packages meant to leave this repo: [`@epicenter/workspace`](packages/workspace), [`@epicenter/ui`](packages/ui), [`@epicenter/filesystem`](packages/filesystem), and [`@epicenter/sync`](packages/sync). They are pre-1.0 and tuned for our own apps, so treat them as fork-and-own rather than a stability-guaranteed SDK for now.

The hard problem with local-first apps is synchronization. If each device has its own SQLite file or Markdown folder, how do you keep them in sync? [`@epicenter/workspace`](packages/workspace) answers by making Yjs the source of truth, then projecting app state to SQLite for queries and Markdown for reading.

Alongside typed tables, local persistence, collaboration hooks, and validated actions, the package gives apps materializers, the writers that project state to disk.

```typescript
import { field } from '@epicenter/field';
import { createWorkspace, defineTable } from '@epicenter/workspace';

const notes = defineTable({
  id: field.string(),
  title: field.string(),
  body: field.string(),
});

const workspace = createWorkspace({
  id: 'notes',
  tables: { notes },
  kv: {},
});

workspace.tables.notes.set({
  id: '1',
  title: 'Hello',
  body: 'Follow up on the README framing.',
});

// Materializers can project that row to Markdown files and SQLite rows.
```

[Read the workspace package docs](packages/workspace/README.md)

## How It Works

Epicenter separates app-owned data from user-owned Markdown. App output belongs under `apps/<name>/`; folders you own stay ordinary Markdown.

```txt
workspace/
|-- apps/<name>/        generated app output; read, grep, quote, copy
|-- .epicenter/         machine state; ignore
|-- journal/            your Markdown; edit, commit, curate, publish
|-- ideas/              your Markdown
`-- publish/            your publishable artifacts
```

The rule is simple: `apps/<name>/` is for reading app output, not hand-editing it. To change app data, use the app or a CLI action validated against the app's schema. To keep something forever, copy it into a folder you own.

Your folders are ordinary Markdown: grep them, open them in Obsidian, version them with Git, publish them with whatever static site stack you like.

```txt
purpose-built app
  -> Yjs live state
  -> Markdown projection for human reading
  -> SQLite mirror for local queries
  -> curated Markdown when something is worth keeping
```

Yjs handles live app state, offline edits, and multi-device sync. SQLite gives scripts and views a fast query surface. Markdown gives you files you can read, quote, copy, version, and publish.

A generated Markdown projection is meant to be boring on purpose (this is the target shape):

```md
---
id: note_123
title: Morning capture
source: app
updatedAt: "2026-06-10T16:49:59.180Z"
---
Follow up on the README framing.
```

Matter applies the same SQLite-mirror idea to the folders you own: it keeps a disposable `matter.sqlite` mirror of each managed folder, so agents and scripts can query your Markdown as SQL:

```bash
sqlite3 matter.sqlite 'select "name" from "journal" limit 5;'
```

## Status

A refresh of Whispering built on the workspace is in progress, and current installs will receive it through the normal release path.

The shared workspace for tabs, notes, drafts, and publishing is being built in public around `@epicenter/workspace`. [Matter](apps/matter) is an early app for user-owned Markdown folders: it edits ordinary Markdown directly and keeps `matter.sqlite` as a query mirror. Other app folders are public research and prototypes.

## Trust Boundaries

Pick the trust model you want.

| Path | What leaves your device |
| --- | --- |
| Whispering with local Whisper C++ | Audio stays on your device when you use local Whisper C++. Transcripts and settings are stored locally by the desktop app. |
| Whispering with a cloud transcription provider | Audio goes from your device to the provider you choose. Epicenter servers are not in that transcription path. |
| Whispering transformations | Transcript text goes to the LLM provider you choose when you enable that step. |
| Hosted Epicenter API or sync | Workspace updates, account/session data, and enabled hosted feature requests go to Epicenter servers. |
| Self-hosted deployable | You control the server, secrets, deployment, and infrastructure boundary. |

Signed-in workspace sync sends your Yjs updates to a trusted relay that reads them in plaintext. On hosted Epicenter the relay is ours, so that data sits inside our trust boundary; self-hosting puts the relay on infrastructure you control, so Epicenter never holds it. See the [trust model](docs/trust-model.md) for the details, including where this is heading with the anchor.

The detailed privacy notes for Whispering live in [apps/whispering](apps/whispering).

## Repo Map

### Product And Workspace Surfaces

| Surface | Status | Notes |
| --- | --- | --- |
| [Whispering](apps/whispering) | Installable app | Desktop speech-to-text with local and bring-your-own-provider transcription paths. |
| [Matter](apps/matter) | WIP product work | Typed grid for user-owned Markdown folders. It edits ordinary `.md` files directly; `matter.sqlite` is a disposable query mirror. |
| [API](apps/api) | Hosted infrastructure | Personal cloud Worker for hosted Epicenter services. Includes hosted-only billing and dashboard code. |
| [Self-host](apps/self-host) | Reference deployable | Community-supported single-partition instance without hosted billing. |
| Other app folders | Research and prototypes | Useful history and experiments, not the current product lineup. |

### Packages

These packages carry the main architecture.

| Package | Role | License |
| --- | --- | --- |
| [`@epicenter/workspace`](packages/workspace) | Core workspace primitives: typed schemas, Yjs documents, local persistence, materializers, actions, and collaboration hooks. | MIT |
| [`@epicenter/sync`](packages/sync) | Yjs sync protocol encoding and decoding. Protocol framing lives separately from transport. | MIT |
| [`@epicenter/ui`](packages/ui) | Shared Svelte component library used by multiple app surfaces. | MIT |
| [`@epicenter/filesystem`](packages/filesystem) | POSIX-style virtual filesystem helpers over workspace data. | MIT |
| [`@epicenter/server`](packages/server) | Shared Hono server library composed by the hosted API and self-host reference deployable. | AGPL-3.0-or-later |
| [`@epicenter/cli`](packages/cli) | The `epicenter` command and local or hosted API workflows. | AGPL-3.0-or-later |

## Architecture

The server side is split into one shared library and two deployable folders:

```txt
packages/server
  shared Hono library
  route composition for auth, sessions, rooms, assets, and provider-backed APIs

apps/api
  hosted personal Cloudflare Worker
  composes packages/server with personal()
  owns hosted-only dashboard and billing code

apps/self-host
  self-hosted single-partition instance reference deployable
  composes packages/server with instance()
  community-supported
  no hosted billing surface
```

[Full architecture walkthrough](docs/architecture.md) | [Trust model](docs/trust-model.md)

## Development

Use Bun in this repo.

```bash
git clone https://github.com/EpicenterHQ/epicenter.git
cd epicenter
bun install
```

Root `bun dev` starts the current default local workflow: the API and Tab Manager.

```bash
bun dev
bun run dev:api
bun run dev:tab-manager:ui
```

See [apps/api/README.md](apps/api/README.md) for local Postgres and Infisical setup. Rust is needed for Tauri surfaces such as Whispering and Matter.

Useful checks:

```bash
bun run typecheck
bun run test
bun run check
```

## Design Notes

Implementation specs and design notes live in [specs/](specs). Start with [docs/README.md](docs/README.md) and [specs/README.md](specs/README.md).

## Contributing

Contributions are welcome. Good entry points are docs, Whispering fixes, local-first infrastructure, Svelte interfaces, and small changes that make the repo easier to understand.

[Read the Contributing Guide](CONTRIBUTING.md)

Contributors coordinate in [Discord](https://go.epicenter.so/discord).

## License

Epicenter uses a two-tier split:

- [MIT](licenses/LICENSE-MIT) for the local-first-on-Yjs developer toolkit: `@epicenter/workspace`, `@epicenter/ui`, `@epicenter/filesystem`, and `@epicenter/sync`.
- [AGPL-3.0](licenses/LICENSE-AGPL-3.0) or later for non-toolkit app surfaces, hosted server code, and internal packages.
- There is no proprietary tier today. Revenue is intended to come from hosting and services, not from selling closed licenses.

Every dependency of the toolkit packages is MIT-compatible, enforced by `bun run check:licenses`. The license split follows the same broad pattern as Plausible and PostHog for hosted open-source services, and Yjs for MIT core libraries with copyleft server pieces.

See the root [LICENSE](LICENSE), [FINANCIAL_SUSTAINABILITY.md](FINANCIAL_SUSTAINABILITY.md), and the [licensing strategy](docs/licensing/licensing-strategy.md) for the full model.

---

<p align="center">
  <strong>Contact:</strong> <a href="mailto:github@bradenwong.com">github@bradenwong.com</a> | <a href="https://go.epicenter.so/discord">Discord</a> | <a href="https://twitter.com/braden_wong_">@braden_wong_</a>
</p>

<p align="center">
  <sub>When an app stops mattering, your files don't. Local-first, open source, built on Yjs.</sub>
</p>
