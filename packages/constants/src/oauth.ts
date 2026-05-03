/**
 * OAuth public client ids registered by the Epicenter API.
 *
 * These identify first-party app types, not users, machines, installs, or
 * secrets. The API uses them to decide which OAuth client is requesting a
 * device-code or native-app auth flow.
 */
export const EPICENTER_DESKTOP_OAUTH_CLIENT_ID = 'epicenter-desktop';
export const EPICENTER_MOBILE_OAUTH_CLIENT_ID = 'epicenter-mobile';

/**
 * OAuth public client id for `epicenter auth login`.
 *
 * Machine auth sends this as `client_id` to `/auth/device/code` and
 * `/auth/device/token`. Every CLI install uses the same value.
 */
export const EPICENTER_CLI_OAUTH_CLIENT_ID = 'epicenter-cli';
