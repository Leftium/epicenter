# 0012. An always-on actor runs app semantics beside the app-blind anchor

- **Status:** Proposed
- **Date:** 2026-06-16

## Context

Epicenter syncs a workspace through a custody and transport node: a hosted relay
(a Cloudflare Durable Object per room) today, and a user-owned home anchor over
Iroh in the cloudless direction. That node is deliberately app-blind; it routes
opaque room bytes and knows no schema, and [ADR-0004](0004-trust-the-relay-reject-zero-knowledge.md)
makes privacy a property of who runs it, not of what it can read. Apps also need
always-on semantic work: stream an assistant turn into a conversation, run the
app's actions, query a local read model. Today that work runs as an HTTP route on
the hosted Worker, which fuses it with the relay deployment and ties it to the
cloud. The recurring confusion is calling the always-on device an "anchor" when it
is being asked to do both jobs.

## Decision

Custody/transport and semantic work are two roles with two names. An **anchor**
(cloudless) or **relay** (hosted) is app-blind: it stores and routes room bytes and
knows no schema, child-doc layout, action, or product semantic. An **actor** is
app-aware: it holds a live replica of a workspace doc, observes it, runs the app's
actions and inference, and writes results back through the workspace protocol. An
actor runs beside the anchor, never inside it. One device may host both, but never
in one code path. Epicenter Cloud is therefore a trusted relay (always) plus
optional managed actors (per app, opt-in); a user-owned box is an app-blind anchor
plus per-app actors. Relay and anchor are two deployments of one custody contract;
the managed cloud actor and the home daemon are two deployments of one actor
contract.

## Consequences

- "Anchor" stays app-blind, so one Rust/Iroh sidecar can multiplex many rooms and
  the topology-privacy claim of ADR-0004 holds.
- The hosted AI route is revealed as a co-located managed actor, not part of the
  relay. When an app's actor runs on the user's own device, the hosted route is
  unnecessary, and private facts never leave the machine.
- An actor is the existing daemon body plus an observe loop, not a new process
  kind. The mount runtime gains a child-doc observe loop
  (`packages/workspace/src/document/child-doc-actor.ts`) over a node-only body
  connector injected through `nodeMountRuntime().connectChildDoc`
  (`packages/workspace/src/daemon/mount-runtime.ts`); both are additive.
- Hosting is schema-driven, symmetric with the browser child-doc opener. A
  browser `connect()` reads the table's `docDecls` and hands the UI
  `tables.<t>.docs.<field>.open(rowId)`; a daemon `mount({ actors })` reads the
  same `docDecls` and runs an observe loop per registered field. The app
  registers behavior only (a per-body factory keyed by table and field); the
  table, the guid deriver, and the layout all come from the schema, never
  re-passed at the call site. Re-passing them would let an actor read a body
  with a layout that disagrees with the schema, the one corruption the
  single-owner derivation forecloses. Only an observable layout (one exposing
  `observe`) can carry an actor.
- Forecloses a single "anchor runtime" that hosts app actors as one fused thing.
  Fusing the contracts would make the relay app-aware again and break both
  multiplexing and topology privacy.

## Considered alternatives

- **One "anchor" that does custody and semantics.** Rejected: it contradicts the
  app-blind premise the cloudless transport depends on.
- **Actors only in the cloud (the status quo HTTP route).** Rejected: it ties
  semantic work to the cloud and forecloses local inference and the cloudless
  topology.
