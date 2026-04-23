/**
 * WebSocket subprotocol auth — shared client/server constants.
 *
 * Auth tokens travel inside the `Sec-WebSocket-Protocol` handshake header
 * as `bearer.<token>`, not in the URL's query string. Query strings land
 * in access logs, proxy caches, referrer headers, and browser history;
 * subprotocol headers don't. The server extracts and consumes the bearer
 * entry on upgrade; only the main protocol name (`epicenter`) is echoed
 * back on the 101 response, so the token never round-trips.
 *
 * The `.` separator is required by RFC compliance — `Sec-WebSocket-Protocol`
 * values are RFC 7230 `token` productions, where `:` is not a valid `tchar`
 * but `.` is. `bearer.<token>` matches Hasura's convention for the same
 * reason.
 */

/** Primary subprotocol name every Epicenter client negotiates. */
export const MAIN_SUBPROTOCOL = 'epicenter';

/** Prefix that identifies a bearer-token subprotocol entry. */
export const BEARER_SUBPROTOCOL_PREFIX = 'bearer.';
