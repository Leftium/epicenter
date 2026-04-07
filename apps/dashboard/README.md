# Dashboard

A billing and credits dashboard for Epicenter customers. It fetches billing data from the hub API, renders usage charts and activity feeds, and drives Stripe flows for top-ups and plan changes.

Part of the [Epicenter](https://github.com/EpicenterHQ/epicenter) monorepo. AGPL-3.0 licensed.

---

## How it works

The dashboard is a SvelteKit SPA with SSR disabled and a static adapter. All data comes from the hub API at `/api`—there's no Yjs, no CRDTs, no local workspace. It's a pure API consumer.

**Auth** uses Google sign-in via `@epicenter/svelte/auth-form`. The session is persisted in localStorage and gates the entire app.

**Overview tab** shows a credit balance progress bar with trial info, a stacked area chart of usage by model over time (D3 + layerchart), and a top-10 models table for the last 30 days.

**Models tab** has a cost guide listing credits-per-call for each model.

**Activity tab** shows a feed of recent billing events.

**Plan management** lives below the tabs: a monthly/annual toggle, a prorated charge preview, and a confirm button to upgrade. Clicking "Buy 500 credits" triggers a mutation that opens a Stripe checkout session. "Manage billing" opens the Stripe billing portal directly.

All UI components come from `@epicenter/ui` (shadcn-svelte). Types for billing contracts and plans come from `@epicenter/api`.

## Development

**Prerequisites**

- Bun
- The hub API running locally (see `apps/api`)

**Start the API first**

```bash
# in apps/api
bun run dev:local
```

The API must be running at `localhost:8787` before starting the dashboard. The Vite dev server proxies `/api` and `/auth` there.

**Start the dashboard**

```bash
# in apps/dashboard
bun run dev:local
```

Runs on port 5178.

**Build**

```bash
bun run build
```

Outputs a static site with `/dashboard` as the base path.

## License

[AGPL-3.0](../../LICENSE). Note that most packages in this monorepo are MIT licensed—this app is the exception.
