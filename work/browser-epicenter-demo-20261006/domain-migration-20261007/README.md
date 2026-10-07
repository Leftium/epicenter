# Zhongwen domain migration, 2026-10-07

The public demo is now https://zhongwen.bradenwong.com. Cloudflare confirms that
its active custom domain belongs to Worker `zhongwen` in the Braden Wong account.
The old `zhongwen.epicenter.so` binding is removed. Its Worker remains available
for recovery with Workers development and preview URLs disabled; it has no
public entrypoint. Other Epicenter domain bindings are unchanged.

The site uses the anonymous Gemini demo build. The hosted API now trusts the
exact new origin and excludes the old origin. An isolated API release retained
the existing generation budget, generations ledger, and store authority
namespace IDs. It includes the previously deployed anonymous tutor and minimal
thinking settings, with the canonical origin changed. Unrelated CLI, billing,
and auth edits in the shared checkout were excluded from deployment.

## Live acceptance

Playwright loaded the real new domain with normal TLS verification, saved an
expression and note offline, and retained them after closing and reopening its
browser profile. Two initial tutor attempts returned sanitized provider errors.
An explicit third request completed with HTTP 200 and its real Gemini reply was
saved to the learner conversation file. There were zero page errors. The public
Sync page correctly says no remote is connected.

The root and conversation deep-link shell returned HTTP 200. The old domain no
longer serves the app. API preflight permits only the new Zhongwen origin.
`public-journey.json`, `public-tutor.png`, and `cloudflare-verification.json` hold
receipts. The first acceptance script stopped on the provider failures;
`retry-tutor.mjs` recorded the successful explicit retry. No automatic retry was
added to the application.

## Deployment receipts

- Zhongwen source commit: `3ed912c0e98286c20df67117b808801091cfae87`.
- Epicenter browser/native transport commit: `493e61f35c3367b49fc5ca6b6f392743520d30ee`.
- Installed native folders: `3cbbb09ea0a0bbedb69464ad86fbb440380c92df`.
- Tutor API and canonical origin: `5ccb4cba53273b5d46c278c74d438c117a269f2c`.
- Public Worker version: `67b56f23-7520-4fff-acc9-a00024fb1ad7`.
- Hosted API version: `d9114f3b-1b94-49f4-8251-5e758600d69c`.

App tests: 172 passed; typecheck has zero errors and warnings. Public demo build,
asset check, and Wrangler dry-run passed. Isolated API tests: 95 passed;
typecheck and its UI build passed. Focused live-checkout API tests also passed.

`bun run deploy` in `/Users/braden/Code/zhongwen` now builds and publishes this
custom domain using the personal Wrangler login. The configuration disables
Workers development and preview URLs. The API still deploys in the Epicenter
account through its existing production credentials.

Browser storage belongs to an origin. This domain change does not copy browser
data from the old origin. Local Git-backed browser/desktop demo data remains at
the same repository and desktop directory. Hosted authenticated Git transport
remains separate work.
