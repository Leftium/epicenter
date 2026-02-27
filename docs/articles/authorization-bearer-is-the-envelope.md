# `Authorization: Bearer` Is the Envelope, Not the Token

`Authorization: Bearer <something>` is a transport mechanism. It tells the server "here's a credential." What `<something>` actually is — that's a separate question entirely, and the answer determines where validation happens.

```
Authorization: Bearer abc123xyz
                       ^^^^^^^^
                       opaque string — random, meaningless without a DB lookup

Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyXzEyMyJ9.abc...
                       ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
                       JWT — self-contained signed JSON, readable without a DB
```

Both travel identically. The header is the same. The difference is entirely in how the server handles what's inside.

## Opaque tokens require a round-trip

An opaque token is a random string. `abc123xyz` carries no information. The server has to ask: "does this string exist in my database, and if so, who does it belong to?"

```
Client                    Server                    Database
  │                          │                          │
  │  Authorization:           │                          │
  │  Bearer abc123xyz  ──────►│  SELECT * FROM           │
  │                          │  sessions WHERE      ────►│
  │                          │  token = 'abc123xyz'      │
  │                          │                      ◄────│
  │◄── 200 ──────────────────│  { userId, expiry }       │
```

Every request is a database query. That's the cost. The upside: revocation is instant. Delete the row, and the token is dead on the next request.

This is what Better Auth's `session_token` is — an opaque string the server stores and looks up.

## JWTs validate locally

A JWT is a signed JSON blob. The payload is base64-encoded and readable without any external lookup:

```
eyJhbGciOiJSUzI1NiJ9  .  eyJzdWIiOiJ1c2VyXzEyMyIsImV4cCI6MTcwMDAwMH0  .  <signature>
       header                              payload                              signature
   (algorithm)                    { sub: "user_123", exp: 1700000 }         (RS256 sign)
```

The server verifies the signature against a public key (fetched from a JWKS endpoint), then reads the claims directly from the payload. No database involved.

```
Client                    Server                    JWKS endpoint
  │                          │                          │
  │  Authorization:           │                          │
  │  Bearer eyJhbG...  ──────►│  fetch public key    ────►│
  │                          │  (cached)            ◄────│
  │                          │                          │
  │◄── 200 ──────────────────│  verify signature         │
  │                          │  decode payload           │
  │                          │  { sub, exp, ... }        │
```

The JWKS fetch is cached — usually for hours. At steady state, validation is pure CPU: no network, no database.

The tradeoff: revocation is hard. A JWT is valid until it expires unless you maintain a blocklist, which brings back the database lookup you were trying to avoid.

## Same header, different tradeoffs

| | Opaque | JWT |
|---|---|---|
| Validation | DB lookup per request | Signature check (local) |
| Revocation | Instant (delete row) | Requires blocklist or short expiry |
| Payload | Nothing (server-side state) | Self-contained claims |
| Typical use | Same-origin sessions | Cross-origin / third-party auth |

The reason you see JWTs in OAuth flows and opaque tokens in session auth isn't arbitrary. OAuth needs the resource server to validate tokens without calling back to the authorization server on every request — JWTs make that possible. Sessions already have a database; the extra lookup is cheap, and instant revocation matters.

`Authorization: Bearer` doesn't care which one you put in it.
