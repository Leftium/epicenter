---
name: asymmetric-wins
description: "Find the small product refusal that collapses a large implementation graph: refuse 10-20 percent of functionality to delete 80-90 percent of complexity. Use when the user says \"asymmetric wins\", \"asymmetric win\", \"what can we refuse\", \"what collapses the most code\", or when a design adds a fast path, fallback parser, provider-specific SDK, second transport, or compatibility alias beside a canonical path. Pairs with one-sentence-test (detects the opportunity) and cohesive-clean-breaks (executes the break)."
---

# Asymmetric Wins

An asymmetric win is a refusal that gives back more complexity than it costs in
product capability. The usual shape: refuse 10-20 percent of functionality and
collapse 80-90 percent of the implementation graph.

This is not arithmetic and not a quota. Do not remove arbitrary features. The
job is to find the one small promise that owns a disproportionate code family,
then decide whether refusing that exact promise leaves the product sentence
intact.

## Compose With

- `one-sentence-test` detects the opportunity (the surface audit surfaces the
  convenience feature that forces a second product sentence). This skill owns
  the decision.
- `cohesive-clean-breaks` executes the resulting breaking change, wave ordering,
  and old-path deletion.
- `greenfield-clean-breaks` and `radical-options` link here instead of
  re-deriving the refusal move.

## When To Run

Run this pass when a design adds:

```txt
a fast path beside the canonical path
a provider-specific SDK wrapper beside a standard protocol
a fallback parser for an old shape
a second transport for one environment's nicer UX
a compatibility alias nobody explicitly asked for
an option that only preserves an old mental model
a partial reflection API that makes callers ask which surfaces are real
```

## Procedure

```txt
1. Name the product sentence that must remain true.
2. List candidate refusal points: fast paths, old shapes, rare modes, provider
   exceptions, compatibility aliases, fallback parsers, partial reflection.
3. For each candidate, list the code family it forces: methods, adapters,
   unions, error variants, tests, docs branches, UI states, migrations.
4. Pick the candidate with the largest code family, not the most visible name.
5. Ask who loses what if that behavior is refused.
6. If the loss is a small convenience and the deletion removes a second shape,
   refuse the behavior and write that refusal into the spec.
```

The rule is deliberately pushy: if the product sentence survives and the code
family disappears, default to refusal. Keep the feature only when the user loss
is load-bearing.

## Decision Template

Use this shape in specs and design notes:

```txt
Product sentence:
  ...

Candidate refusal:
  ...

Code family it deletes:
  ...

User loss:
  ...

Decision:
  Refuse it / keep it because ...
```

## Worked Example: Social Sign-In

```txt
Product sentence:
  All social sign-in routes through the API-hosted page via OAuth 2.1 PKCE.

Candidate refusal:
  Browser SPAs can use Google GIS for a roughly 1-second sign-in.

Code family it deletes:
  signInWithIdToken
  OIDCProvider narrowing
  per-app GIS helpers
  GIS blocked-browser UI
  SocialSignInUnavailable
  provider-specific SDK scaling for Apple and Microsoft
  two social sign-in docs branches
  two social sign-in test paths

User loss:
  Google sign-in is a few seconds slower in browser SPAs.

Decision:
  Refuse it. The UX loss is small; the second auth shape is permanent.
```

The product still has social sign-in. It refuses one fast path so one invariant
can own every provider and environment.

For narrative context, see
`docs/articles/20260504T160541-asymmetric-wins-support-fewer-features-to-collapse-complexity.md`.
