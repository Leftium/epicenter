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

## Browser implementation and deployment

The browser caller was built in the isolated clone
`/tmp/zhongwen-hosted-browser-20261008`, starting at Zhongwen
`e38ec4600b30d48aab26f9196b43240ebd4ca6bd`. The clone preserves the committed
practice work and uses the accepted hosted client leaves. It owns resource-free
Sync and authorization routes, explicit pairing/download, and captured account
dataset selection. Local selection must survive sign-in. Account opening must
remain existing-only until explicit Download publishes the history.

The accepted patch was combined with practice commit
`1af559f1046b47fccb43fc2189969f24973e58dd` in
`/tmp/zhongwen-live-integration-20261008`, preserving ExpressionsEditor.
Mounted acceptance verified that unsaved Expressions repair input survives
Settings and Sync navigation.

The combined source passed 298 Bun tests with 1,221 assertions, 116 mounted
component tests, and type checking with zero errors or warnings. Both browser
and installed-SPA release builds passed. All eight copied private package
trees matched their prepared source bytes. A fresh frozen dependency install
stalled and was stopped; copied dependency validation is not a fresh-install
claim.

Chromium passed all 13 hosted-fixture journey steps, both fresh-document
recipe cases, and the retained repair-input check. These use fixture identities
and Git transport, not real GitHub authorization.

Zhongwen commit `1db1476` contains the integration and verification record.
Deployment to `zhongwen.bradenwong.com` succeeded with Worker version
`6a887f22-ed64-4ad7-a284-ca5a5c952034`. Zen visibly reached the new Sync
setup and its Epicenter sign-in flow. No push was performed.

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

The next deciding check is real
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
The integrated caller downloads before opening and opens existing-only.
Its durable recipe records successful Download separately from existing-folder
refusal. Unverified recipes leave existing data editable without enabling
Sync. Repository ID and branch cannot change after successful Download.
The obsolete post-open bootstrap was removed.

## Live sign-in failure

Zen and three fresh Chromium contexts reproduced the same failure:
`POST /auth/sign-in/social` returns HTTP 500 and the page says
“Could not start sign-in.” The request fails before redirecting to GitHub.
The hosted Worker log identifies the failed OAuth verification INSERT;
GET `/auth/get-session` without a cookie does not execute SQL and therefore
does not prove database health.

A read-only connection using Infisical production `/ops` returned PostgreSQL
code `28000`: branch `d344al8j3fru` does not exist. Sanitized configuration
comparison confirmed that both the admin URL and deployed Hyperdrive origin
user reference that missing branch. No database schema, credential, or
Hyperdrive setting was changed during diagnosis. PlanetScale is open in Zen,
signed out, awaiting access to identify the correct surviving database target.

The temporary Worker-tail file contained OAuth parameters. Its owned tail
processes were stopped, and the file was removed after diagnosis. Recorded
diagnostic output contains only sanitized errors and configuration comparisons.

## Supabase replacement investigation (before the switch)

The user requested Supabase as a replacement on October 8. Its dashboard is
open in Zen and requires sign-in. No project, database, credentials, or
production binding has been changed. Current credit availability must be
verified in the dashboard; earlier offer emails do not prove a current balance.

The proposed path is Supabase Postgres behind the existing Cloudflare
Hyperdrive binding. Keep pg, Drizzle, Better Auth, and the hosted GitHub
connector. Cloudflare's Supabase guide requires the Direct connection rather
than Supabase's pooler, since Hyperdrive pools connections itself:
https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-database-providers/supabase/

Before switching, identify the target organization/project and determine
whether existing identity rows can be recovered. Preserve user IDs when
migrating: those IDs address hosted data and folder pairings. A fresh auth
database would create new identities, so it is not equivalent to restoring
the existing service. Inspect the target schema before applying
`apps/api/drizzle/0000_direct_sessions.sql`. Configure a database role with
only the required permissions, update both the runtime Hyperdrive target and
Infisical production `/ops` admin connection, then prove real social sign-in
before resuming GitHub authorization and browser/native transfer acceptance.

Read-only deployment comparison found the current and previous API versions
use the same Hyperdrive binding. Two other configurations exist, but neither
has been established as healthy or as the correct target; neither was used.

## Native integration and review closure

The native candidate adds explicit Download before opening an account dataset,
a credential-free immutable repository binding, and a captured-account
loopback Git relay. Local datasets keep their existing behavior. Download
preserves occupied destinations and incomplete files for inspection. Discovery
does not replace an existing binding or origin.

Independent reviews retained the native folder owner, Bun Account relay, and
durable binding. The full pairing check remains necessary: a hand-edited
binding can combine one repository's ID with another repository's revision.
The final closure changes the absence label to "Download data to this device
to open the app" and adds actual Account HTTP tests for cancellation of
requests with streamed upload bodies before the response arrives.

The isolated candidate passed core 165, native app 241, plugin 20, and host/auth
331 tests before that closure. Existing hardware/doc ignores and the generated
binding export test remain excluded. Home and sidecar builds passed. The
closure passed 19 focused tests with 71 assertions and auth type checking.
Parent verification repeated the real Git relay suite: 4 tests, 35 assertions.
Parent also repeated both new streamed POST cancellation tests: 2 tests,
6 assertions. No production transport code changed in the final closure.

The loopback capability remains briefly visible in Git's process arguments.
A push can land before an interrupted exchange reports failure; there is no
automatic retry. A capability-header experiment and a landed-response-
interruption probe were not run. Pairing-read cancellation can wait for its
bounded timeout. These limits are recorded rather than claimed as verified.

The candidate has not been installed as a new native release. Actual Home IPC,
hosted GitHub authorization, live private transfers, browser/native continuity,
and second-account isolation still require acceptance after database repair.

## Frankfurt production switch

The user explicitly chose a fresh database without recovering old identities
or their hosted-data links. Production now uses Supabase project `epicenter-api`
(`gfdyrfsuiphzsbbzjofg`, Frankfurt). The six-table migration was applied once.
The runtime role has CRUD access only to those tables. The Supabase Data API
is disabled. Admin commands use the IPv4 session pooler with certificate and
hostname validation; Hyperdrive uses the direct database endpoint with caching
disabled.

API version `ce4e9172-5ce6-4282-a916-2bfa64eb2d9f` deploys the previously
verified release with the Frankfurt binding. GitHub social sign-in returned
success and Zhongwen's Sync page showed "Signed in to Epicenter." The production
migration command and API type check passed. These checks establish database
and social-login recovery, not private Git transfer or browser/native acceptance.

Ohio project `epicenter-api-2` was deleted. Both benchmark Workers, both
benchmark Hyperdrives, the Frankfurt benchmark table, and temporary benchmark
scripts and credentials were removed. The measurements remain in the local
benchmark report. PlanetScale's final database deletion remains pending
action-time confirmation. GitHub repositories and hosted data namespaces were
not deleted.
