/**
 * WebSocket subprotocol auth — shared client/server constants.
 *
 * Auth tokens travel inside the `Sec-WebSocket-Protocol` handshake header
 * as `bearer.<token>`, not in the URL's query string. The real threat is
 * server-side access logs (Cloudflare, Hono middleware, downstream APMs
 * like Sentry/Datadog): full URLs including query strings are captured by
 * default, so a `?token=` scheme leaks long-lived session tokens into any
 * system with log access. Subprotocol headers aren't captured by default
 * on those systems. The server extracts and consumes the bearer entry on
 * upgrade; only the main protocol name (`epicenter`) is echoed back on
 * the 101 response, so the token never round-trips.
 *
 * The `.` separator is required by RFC compliance — `Sec-WebSocket-Protocol`
 * values are RFC 7230 `token` productions, where `:` is not a valid `tchar`
 * but `.` is. Prior art for `<scheme>.<token>`: Phoenix channels
 * (`phx_bearer.<token>`), Supabase Realtime, and Kubernetes
 * (`base64url.bearer.authorization.k8s.io.<token>`).
 */

/** Primary subprotocol name every Epicenter client negotiates. */
export const MAIN_SUBPROTOCOL = 'epicenter';

/** Prefix that identifies a bearer-token subprotocol entry. */
export const BEARER_SUBPROTOCOL_PREFIX = 'bearer.';
