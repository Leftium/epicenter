/**
 * OAuth public client id for `epicenter auth login`.
 *
 * Better Auth's device authorization plugin requires `client_id` on both
 * `/auth/device/code` and `/auth/device/token`. This identifies the CLI app
 * type, not a user, machine, install, or secret. Every CLI install uses the
 * same value.
 */
export const EPICENTER_CLI_OAUTH_CLIENT_ID = 'epicenter-cli';
