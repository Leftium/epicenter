# Cloudflare Workers Deployment

CI/CD pipelines for deploying Whispering and Landing to Cloudflare Workers.

## Workflows

### `deploy-cloudflare.yml` — Production

Triggers on push to `main` or manual dispatch.

1. **Validate**: installs deps, type-checks, lints, builds all packages
2. **Deploy**: uploads build artifacts to Cloudflare Workers via `wrangler deploy`
3. **Notify**: posts deployment summary to GitHub and optionally Discord

Both apps deploy in parallel after validation passes.

### `preview-deployment.yml` — PR Previews

Triggers on pull requests that touch `apps/whispering/**`, `apps/landing/**`, or `packages/**`.

Uses `wrangler versions upload --preview-alias` to create preview URLs without affecting production traffic. Preview aliases are retained automatically (up to 1000 per worker) — no cleanup workflow needed.

Preview URLs follow the format: `<alias>-<worker-name>.<subdomain>.workers.dev`

## Prerequisites

### Cloudflare API Token

Generate at https://dash.cloudflare.com/profile/api-tokens with permissions:
- **Account**: Workers Scripts:Edit

### GitHub Secrets (required)

| Secret | Description |
|--------|-------------|
| `CLOUDFLARE_API_TOKEN` | API token with Workers Scripts:Edit |
| `CLOUDFLARE_ACCOUNT_ID` | Found in Cloudflare dashboard sidebar |

### GitHub Secrets (optional)

| Secret | Description |
|--------|-------------|
| `DISCORD_WEBHOOK_URL` | Discord webhook for deployment notifications |

## Workers Configuration

Both apps are assets-only Workers (no server-side code, just static files):

- **Whispering** (`apps/whispering/wrangler.jsonc`): SPA with `single-page-application` not-found handling
- **Landing** (`apps/landing/wrangler.jsonc`): Static site with `404-page` not-found handling

Both have `"preview_urls": true` to enable `--preview-alias` support.

## Rollback

Revert the commit on `main` and push — the deploy workflow will redeploy the previous version.

For immediate rollback without a new commit, use:
```sh
bunx wrangler rollback --name <worker-name>
```

## Troubleshooting

- **"API token is invalid"**: verify token permissions and that it hasn't expired
- **"Worker not found"**: ensure the worker name in `wrangler.jsonc` matches an existing worker, or let `wrangler deploy` create it
- **Build fails**: run `bun run build` locally to reproduce
- **Preview URL not appearing in PR comment**: check that `deployment-url` output is populated in the workflow logs
