# Hosted connector execution, October 8

## Deployed source

The production API was deployed from a clean standalone clone at
`/tmp/epicenter-github-release-20261008`, source commit `17724f7fd6`.
It excludes concurrent uncommitted CLI callback and application changes.
Worker version: `fa1829a1-b36a-4c13-a741-45c0016ba0f4`.

The committed source reads `GIT_GRANT_ENCRYPTION_KEY`. Infisical production
`/api` now holds that name with the exact previous sealing-key value. The old
shared `GIT_GRANT_KEY` entry was removed after deployment. A subsequent deployed
secret-name listing confirms the new name is present and the old name is absent.
Social sign-in's `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` remain separate.
No credential value is recorded here.

## Verification

- Focused connector tests: 85 passed, zero failed, 508 assertions.
- Clean-clone frozen installation and Worker dry-run build passed.
- Production deployment succeeded, including the GitHubConnection binding.
- Unauthenticated `/api/git/github/pairings`: HTTP 401.
- Invalid `/api/git/github/callback?state=invalid`: HTTP 400.
- `/sign-in`: HTTP 200.

These checks prove endpoint admission and deployment, not GitHub authorization
or Git transfer. No live scoped-token transfer has been accepted.

## Current implementation wave

The browser caller is being built in the isolated clone
`/tmp/zhongwen-hosted-browser-20261008`, starting at Zhongwen
`e38ec4600b30d48aab26f9196b43240ebd4ca6bd`. The clone preserves the committed
practice work and uses the accepted hosted client leaves. It owns resource-free
Sync and authorization routes, explicit pairing/download, and captured account
dataset selection. Local selection must survive sign-in. Account opening must
remain existing-only until explicit Download publishes the history.

The live checkout has a newer uncommitted ExpressionsEditor change. Integration
must preserve it. Settings-to-Sync must also preserve unsaved retained repair
edits when the new resource-free route unmounts the editor.

## External acceptance gate

The selected-repository installation form was prepared for
`braden-w/zhongwen-data` and `braden-w/honeycrisp-data`. The latter is a read-only
acceptance target for proving that a Zhongwen-scoped token cannot access another
repository granted to the parent App. The final Install action remains pending
the requested action-time confirmation. No Honeycrisp data will be modified.

After the caller is reviewed and deployed, the next deciding check is real
account authorization, pairing, scoped fetch/push, and refusal of the other
repository. Browser-to-installed-Epicenter continuity and second-account
isolation remain outstanding.
