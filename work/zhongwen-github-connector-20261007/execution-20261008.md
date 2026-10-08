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

The live checkout now includes practice commit
`1af559f1046b47fccb43fc2189969f24973e58dd`. Integration must preserve its
ExpressionsEditor changes. Settings-to-Sync must also preserve unsaved retained repair
edits when the new resource-free route unmounts the editor.

## External acceptance gate

The user confirmed installation, and Zen completed it on October 8 at 10:33 AM
GMT+8. GitHub displayed the success banner and installation settings at
`https://github.com/settings/installations/169082319`. The saved settings show
Only select repositories, exactly `braden-w/zhongwen-data` and
`braden-w/honeycrisp-data`, Contents read/write, and Metadata read.
The latter is a read-only acceptance target for proving that a Zhongwen-scoped
token cannot access another repository granted to the parent App.
No Honeycrisp data was modified.

Native Zen mouse controls initially did not activate the selector. Resetting the
control session and reloading did not resolve it. A fresh task tab with active
Zen subsequently responded to clicks and completed installation. A separate
headed Playwright Chromium also demonstrated working input focus but required
a fresh GitHub login; it was not used for the grant. No credentials or browser
session cookies were copied.

After the caller is reviewed and deployed, the next deciding check is real
account authorization, pairing, scoped fetch/push, and refusal of the other
repository. Browser-to-installed-Epicenter continuity and second-account
isolation remain outstanding.

## Local download correction

Folder commit `3127cb33a5` allows an explicit Local scope in the existing
browser download operation. The scope remains required; account identity is
optional. Download still owns only a fresh destination or the exact pending
download. It retains partial files on failure, and ready folders remain outside
its ownership. Independent reviewers accepted this narrower promise and
rejected destructive rollback.

The focused download suite passed 23 tests with 237 assertions. Folder type
checking reported zero errors and warnings. New Local checks establish remote
history before definition publication, unchanged ready-folder refusal, and
retained partial history with exact-recipe retry in the development channel.
The caller follow-up must download before opening, refuse a different existing
origin, accept only the exact ready-folder refusal, and open existing-only.
The obsolete post-open bootstrap is being removed in the browser clone.

Zen independently observed the public `/sync` page after installation. It
still displays the Local-only launcher instructions and states that the website
does not sync. This confirms that deploying the API did not deploy the caller.
