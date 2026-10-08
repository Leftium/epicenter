# Connector prototype and revised acceptance

The October 7 user steer supersedes the fixed-repository, browser-local connection model. This directory retains prototype evidence and the subsequent account-scoped implementation evidence.

Current status, October 8: the account-scoped API is deployed, and the GitHub
App is installed on `braden-w/zhongwen-data` and `braden-w/honeycrisp-data`.
The browser caller is undergoing correction and review in an isolated clone.
The public Zhongwen Sync page still says that this website does not sync.
Live GitHub authorization and scoped transfers, installed-app continuity,
and second-account isolation remain unverified. See
[the execution record](execution-20261008.md).

Standalone implementation clones:

- `/tmp/zhongwen-github-connector-20261007`: server prototype under `apps/api/worker/git-connector/`.
- `/tmp/zhongwen-github-ui-20261007`: Zhongwen connection and Sync UI prototype.

`prototype/` retains the reviewed production-shaped source from those clones, excluding credentials. It is a review snapshot, not an installed package. No source from it has been integrated into the live API or Zhongwen.

`public-baseline.json` and its screenshot observe the deployed public Sync page before this work. `journey.json` and the nine named screenshots document automated Chromium against disposable profiles, a simulated OAuth provider, the server prototype, and a real `git http-backend` bare repository. The successful run recorded three entries at Git commit `6bb6ae67d22385d7800fbed8db4a33d16bae6db9` and no browser page errors. It tested offline editing of an already-loaded page; offline asset loading and document navigation are not promised.

`fixture.ts` is a test-only launcher template: copy it into the same `work/zhongwen-github-connector-20261007/` location in the server clone and run it there. Its relative imports target that clone's implementation and dependencies. The fixture binds `127.0.0.1:8788`, creates a scratch bare repository, simulates provider consent/token endpoints, and redirects the provider's browser hop locally. No fixture bypass is in the Worker implementation. Run the UI clone's dev script with `VITE_GIT_CONNECTOR_ORIGIN=http://localhost:8788`, then run `journey.mjs` here. These launchers verify the superseded prototype protocol, not the revised account contract. Disposable data from earlier failed runs must not be reused as an empty remote.

The earlier `journey-failure.json` documents test-harness issues: the Add dialog automatically closes, and the wrapped Git error did not match an exact-text locator. Those were corrected in the successful runner. Loading an unvisited development route while offline also exposed unavailable route assets; the successful test stays on the already-loaded page before going offline.

Reproduced checks:

```text
server clone: bun test apps/api/worker/git-connector/
59 pass, 0 fail

UI clone: bun test src/lib/github-connection.test.ts src/lib/sync.test.ts
          src/lib/sync-session.test.ts scripts/local-sync-relay.test.ts
120 pass, 0 fail

live root before prototype integration: bun run --cwd apps/api typecheck
passed
```

Two independent account-ownership reviews were commissioned after the steer. The accepted direction preserves account-qualified folders and existing Account retirement. A transient GitHub identity followed solely by installation permissions does not establish continuing user authorization after revocation. Retain the encrypted user grant for current consent checks; investigate repository-scoped transfer credentials without exposing provider tokens to pages or files. Provider failures must not use the Epicenter session's HTTP 401 signal.

Reuse route/header allowlists, bounded transfer streams, redirect refusal, no POST replay, OAuth PKCE, encryption, and refresh ordering. Replace the global repository constant, anonymous connector bearer, connection-as-folder ownership, Local-folder attachment, and client-only account isolation. A pairing survives expired credentials. Discovery never rewrites an existing origin.

Next acceptance remains browser → private GitHub repository → source-built installed Zhongwen on the same Epicenter account → browser. Native account folder registration and transport, live hosted authorization/transfers, and second-account isolation remain open. The public website is unchanged.

Practice ownership was updated in `/tmp/zhongwen-practice-20261007/sync-ownership.txt`. No practice, learner, drafts, tutor, or route implementation has been edited in the live checkout by this pass.
