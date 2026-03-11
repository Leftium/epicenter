# @epicenter/constants

Shared URLs and version info for the Epicenter monorepo. Each runtime context gets its own subpath export so bundlers only pull in what they need and types resolve correctly.

## Exports

### `@epicenter/constants/apps`

Runtime-agnostic factory. No dependency on `import.meta.env`, `process.env`, or Cloudflare bindings—works in any JavaScript environment.

```typescript
import { createApps } from '@epicenter/constants/apps';

// Browser extension that always talks to production:
const API_URL = createApps('production').API.URL;

// Server that reads env at startup:
const apps = createApps(process.env.NODE_ENV === 'production' ? 'production' : 'development');
```

`createApps` returns URLs for three apps:

| Key     | Production                        | Development              |
|---------|-----------------------------------|--------------------------|
| `API`   | `https://api.epicenter.so`        | `http://localhost:8787`  |
| `SH`    | `https://epicenter.sh`            | `http://localhost:5173`  |
| `AUDIO` | `https://whispering.epicenter.so` | `http://localhost:1420`  |

### `@epicenter/constants/vite`

Pre-evaluated for Vite apps. Calls `createApps` with `import.meta.env.MODE` at build time so consumers get a plain object.

```typescript
import { APPS } from '@epicenter/constants/vite';

const whisperingUrl = APPS.AUDIO.URL;
```

### `@epicenter/constants/versions`

Monorepo-wide version string, stamped by CI on each release.

```typescript
import { VERSION } from '@epicenter/constants/versions';
```

## Adding a new app

Add a new entry to the return object in `src/apps.ts` with production and development URLs. Every subpath export picks it up automatically.
