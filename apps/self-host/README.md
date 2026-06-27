# Epicenter Self-Hosted Instance (Reference)

A self-hosted Epicenter is one instance: a single workspace partition behind one bearer token you generate and hand out. There are no accounts, no OAuth app to register, no sign-in flow, and no mode to pick. You run the box, you generate a token, and everyone you give that token to reaches the same data. Not operated by Epicenter: you run the infrastructure, so Epicenter never holds or sees what is stored here.

"Solo" and "shared" are not settings. They are just how many people you hand the one token to. A homelab box for yourself and a small wiki for your family or lab are the same deployment; the only difference is the size of the group that holds the credential.

## Quick start (Bun, the blessed path)

The whole box is `bun server.ts`: no database, no Cloudflare account, nothing to provision. Generate a token, supply it as `INSTANCE_TOKEN`, and boot:

```bash
# 1. Generate a strong token (256 bits, base64url). Persists nothing.
bun run --cwd apps/self-host gen-token
#   -> Hq9...43-char-token...kQ

# 2. Boot the instance with that token.
INSTANCE_TOKEN=Hq9...kQ \
DATA_DIR=/var/lib/epicenter \
bun apps/self-host/server.ts
```

Then paste the same token into the client's instance setting (`{ baseURL, token }`), once. Every request from that client arrives as `Authorization: Bearer <token>` and authenticates against `owners/instance`. Hand the token to one person or to your whole group; the command is identical either way.

Boot fails closed if `INSTANCE_TOKEN` is missing or too weak, and the error names `gen-token`. The box never mints or stores a token: you own the secret, which is exactly what lets the same instance run on Cloudflare too. To rotate, generate a new token, restart with it, and redistribute it; there is no per-person revocation (see [Offboarding](#offboarding-and-rotation)).

`INSTANCE_TOKEN` is the only required variable. The instance needs no database and no auth secret: it composes no Better Auth and stores rooms as `bun:sqlite` files on local disk (ADR-0073). `DATA_DIR` holds that room data; persist it.

### Use TLS

A static bearer over plaintext HTTP is total compromise: anyone who sees one request can capture the token and replay it forever. Terminate TLS in front of the box (Caddy, nginx, a Cloudflare Tunnel) and serve the instance over HTTPS. A homelab on a trusted LAN behind its own boundary is your call, but the moment the box is reachable over the open internet, plain `http://` hands out the keys.

## Running on Cloudflare

The same `@epicenter/server` composition runs as a Worker (`worker/index.ts`). It works because you supply the secret; there is no first-boot minting that would tie the instance to a single Bun process. Set the token, then deploy:

```bash
bun run --cwd apps/self-host gen-token | tr -d '\n' | \
  bunx wrangler secret put INSTANCE_TOKEN --cwd apps/self-host

bun run --cwd apps/self-host typecheck
bun run --cwd apps/self-host deploy
```

`INSTANCE_TOKEN` is the only secret to set: the instance composes no Better Auth and no Postgres, so there is no `BETTER_AUTH_SECRET` and no Hyperdrive binding (ADR-0073). Set `API_PUBLIC_ORIGIN` in `wrangler.jsonc` to your domain, and provision the one Durable Object binding the file documents. On Cloudflare the entropy gate cannot run at boot (a Worker has no module-scope env), so use `gen-token` for the secret; a weak or unset `INSTANCE_TOKEN` simply fails all auth (fail closed) rather than refusing to boot.

`worker-configuration.d.ts` is hand-written: it inherits the library's binding contract (`ServerBindings`) and declares only the deployment-owned `API_PUBLIC_ORIGIN` and `INSTANCE_TOKEN`. If you add bindings of your own, declare them there (or regenerate with `bun run typegen` and re-add the `extends` clause).

## What this isn't

This is not Epicenter Cloud. There are no Autumn billing routes, no dashboard SPA, and no SLA, support contract, or paid hosting from Epicenter. There is also no per-user partitioning: every valid token reaches the one `owners/instance` partition. Multi-tenancy, where everyone signs in and gets their own private namespace, is Epicenter Cloud's only. An enterprise that wants on-prem runs one instance (shared), or one instance per person or team.

Community-supported. Issues filed against this folder are accepted as community contributions.

## Composition

The whole instance is the same handful of lines on either runtime. Bun:

```ts
startBunServer({
  ownership: instance(),                                  // pin owners/instance
  resolveUser: createInstanceTokenResolver(verifyEnvToken(token)), // one bearer
  // ...session + rooms + inference, no billing, no SPA
});
```

Cloudflare reads the per-request secret at the edge instead:

```ts
createServerApp({
  resolveUser: (c) =>
    createInstanceTokenResolver(
      verifyEnvToken((c.env as Cloudflare.Env).INSTANCE_TOKEN ?? ''),
    )(c),
  // ...instance() ownership, same session + rooms + inference mounts
});
```

Deliberately absent: `mountBillingApi`, any OAuth provider, a launch-time mode selector, an admission allowlist, and first-boot token minting. The shape is the contract.

## Offboarding and rotation

A multi-person instance has one honest cost: removing someone means rotating the token and redistributing it to everyone who stays. There is no per-member revocation and no authenticated attribution; whoever holds the token is the instance owner, and attribution in collaborative presence is self-declared. This is fine for the trusted small group an instance targets (a family, a club, a lab, a small team) and gets painful past roughly six to eight people with involuntary churn.

The escape, when that pain is real, is named per-person tokens: a hashed token registry behind the same verifier and the same constant partition, so each person gets their own revocable token and a server-stamped identity, with zero data migration. It is a deliberately unbuilt seam (ADR-0073). If you are hitting the offboarding cliff, that is the signal to build it, or to move to Epicenter Cloud, which is multi-tenant by design.

## See also

- [ADR-0073](../../docs/adr/0073-self-host-is-a-single-partition-instance-behind-one-operator-supplied-bearer.md) for why an instance is one partition behind one bearer
- [ADR-0074](../../docs/adr/0074-the-relational-auth-substrate-is-a-cloud-only-layer-the-instance-composes-neither.md) for why the instance composes no Better Auth and no Postgres
- `apps/api` for the hosted personal cloud variant (OAuth, per-user partitions, billing)
- `packages/server` for the shared library both deployables compose
