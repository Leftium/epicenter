# Repository GitHub App registration

Registered through GitHub's browser form on October 7 after explicit user confirmation. [Epicenter Folder Sync](https://github.com/apps/epicenter-folder-sync) is owned by EpicenterHQ. It is separate from the Epicenter and Epicenter Dev social-login OAuth Apps.

App ID: `5223530`. Client ID: `Iv23liVOZq7MxkQXPluj`. Slug: `epicenter-folder-sync`. These are public identifiers. A subsequent `gh api apps/epicenter-folder-sync` read confirmed the owner, identifiers, Contents write, Metadata read, and no subscribed events. The submitted form selected any-account installation, expiring user tokens, no wildcard callback, and disabled webhooks, installation OAuth, and device flow.

GitHub displayed "Registration successful" and requires a private key before installation. No private key or client secret was generated. Computer-use policy requires the user to perform authentication credential creation. The next handoff is to generate those credentials in GitHub and save them in the operator's secret store. Never paste credential values into chat.

Prepared Infisical `prod` `/api` using the authenticated CLI: public
`GIT_GITHUB_CLIENT_ID`, public `GIT_GITHUB_APP_SLUG`, and a fresh 32-byte
`GIT_GRANT_KEY`. Existing entries were checked before writing. The key passed
directly through process input; it was never printed or saved in source or an
evidence file. `GIT_GITHUB_CLIENT_SECRET` remains absent. These Infisical entries
have not been transferred to the deployed Worker.

Use these settings for the first authorization probe:

| Setting | Value |
| --- | --- |
| Name | Epicenter Folder Sync, subject to GitHub name availability |
| Owner | EpicenterHQ |
| Installation audience | Any account |
| Homepage | `https://epicenter.so` |
| User authorization callback | `https://api.epicenter.so/api/git/github/callback` |
| Expiring user access tokens | Enabled |
| Repository Contents | Read and write |
| Repository Metadata | Read |
| Repository Administration | No permission for the existing-repository selection probe |
| User authorization during installation | Disabled for the separate state-bound Connect ceremony |
| Webhooks | Not needed for the on-demand authorization probe |

The callback is a planned integration endpoint, not a deployed route. Complete and test the account-bound callback before attempting the hosted user journey. Installation and user authorization are separate: installing selected repositories does not bind them to an Epicenter principal. Connect verifies the GitHub user and installation access under the initiating Epicenter account before pairing.

Keep the App private key and client secret in deployment secret storage. Never put them in source, folder files, Git configuration, browser storage, URLs, command arguments, or this evidence directory. Store any retained user grant encrypted with a key outside its database. App credentials are not the existing `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` used for Epicenter sign-in. The current connector requires `GIT_GITHUB_CLIENT_ID`, `GIT_GITHUB_CLIENT_SECRET`, and a 32-byte base64 `GIT_GRANT_KEY`. `GIT_GITHUB_APP_SLUG` enables installation links. The private key is required by GitHub's installation setup but is not consumed by the current user-token connector.

Install on selected repositories for the first account. Preserve `braden-w/zhongwen-data`, repository ID `1406974656`; it already has history. A second authorized repository is needed for a scope-refusal probe. Do not initialize, recreate, or mutate the other existing data repositories for that probe without a concrete acceptance need.

The deciding live probe compares two credentials available to the same user and installation. Mint a scoped user token with the designated immutable repository ID and Contents permission. Demonstrate Git fetch and push to that repository, refusal at the second authorized repository, token lifetime, behavior after parent-token rotation, and behavior after user authorization revocation. If those properties do not hold, retain the live user-grant consent check and mint a repository-scoped installation token per transfer. Neither path may rely on a name lookup plus a broad credential.

Native credential delivery needs a separate hostile-configuration fixture before integration: helpers, hooks, Git tracing, URL rewriting, and proxies must not receive the credential or redirect an authenticated request to another destination. No native ticket or credential mechanism is accepted solely from its proposed API.
