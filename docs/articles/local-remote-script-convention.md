# Your Script Names Should Tell You Which Database They'll Destroy

**TL;DR**: Suffix every database-touching script with `:local` or `:remote`. Commands that don't touch a database stay unsuffixed. Now there's no ambiguity about what a command will hit before you run it.

## The Problem

You're working on a Cloudflare Workers project. You have drizzle-kit for migrations and a Hyperdrive-connected Postgres database in production. Here's what your environment actually looks like:

```
Local Postgres          ◄── development, safe to nuke
Dev Branch DB           ◄── shared, Infisical-injected DATABASE_URL
Production via Hyperdrive ◄── env.HYPERDRIVE at runtime, not a URL
```

Three databases. One `drizzle-kit push` command. No indication which one it hits.

You're staring at `bun run db:push` and asking yourself: is this going to wipe my local schema, or is it going to push directly to the dev database that two other people are using? You don't remember which `.env` you have loaded. You don't remember if Infisical is injecting anything. You run it anyway because you're in a hurry.

That's the problem. The script name gives you zero information about blast radius.

## The Convention

Name every database-touching script with an explicit `:local` or `:remote` suffix. If a command doesn't actually connect to a database, leave it alone.

```json
"scripts": {
    "db:generate": "drizzle-kit generate",
    "db:drop": "drizzle-kit drop",
    "db:push:local": "drizzle-kit push",
    "db:push:remote": "infisical run --path=/api -- drizzle-kit push",
    "db:migrate:local": "drizzle-kit migrate",
    "db:migrate:remote": "infisical run --path=/api -- drizzle-kit migrate",
    "db:studio:local": "drizzle-kit studio",
    "db:studio:remote": "infisical run --path=/api -- drizzle-kit studio"
}
```

`db:generate` and `db:drop` have no suffix because they never touch a database. `db:generate` diffs your schema files and produces SQL. `db:drop` deletes a local migration file. Both are pure filesystem operations. Suffixing them would be noise.

Everything else gets a suffix. No exceptions.

## The Implementation

### `:local` scripts

`:local` scripts run `drizzle-kit` directly with no extra setup. The fallback chain in `drizzle.config.ts` does the rest:

```ts
dbCredentials: {
    url: process.env.DATABASE_URL ?? LOCAL_DATABASE_URL,
}
```

`LOCAL_DATABASE_URL` is a constant parsed from `wrangler.jsonc`'s `localConnectionString`:

```
postgres://postgres:postgres@localhost:5432/epicenter
```

If `DATABASE_URL` isn't set in the environment, drizzle-kit falls through to the local Postgres. `:local` scripts rely on that fallback being the only thing available — no secrets injected, no env vars set.

### `:remote` scripts

`:remote` scripts are prefixed with `infisical run --path=/api --`:

```
infisical run --path=/api -- drizzle-kit push
```

Infisical injects `DATABASE_URL` before the command runs. That URL points to the dev-branch or production Postgres, depending on your Infisical environment. drizzle-kit picks it up because it takes priority over the `LOCAL_DATABASE_URL` fallback.

The same pattern applies to `dev`:

```json
"dev:local": "wrangler dev",
"dev:remote": "infisical run --watch --path=/api -- wrangler dev",
```

`dev:remote` adds `--watch` so Infisical refreshes secrets if they rotate during a long session.

## The Three-Layer Strategy

```
┌──────────────┬────────────────────────────────────┬──────────────────────────────────┐
│ Layer        │ Source                             │ Used By                          │
├──────────────┼────────────────────────────────────┼──────────────────────────────────┤
│ Local        │ wrangler.jsonc localConnectionString│ :local scripts, contributors     │
│ Migration    │ Infisical DATABASE_URL              │ :remote scripts                  │
│ Runtime      │ Hyperdrive env.HYPERDRIVE           │ Production worker                │
└──────────────┴────────────────────────────────────┴──────────────────────────────────┘
```

The production worker never uses `DATABASE_URL` directly. It uses `env.HYPERDRIVE` — the Cloudflare binding — which handles connection pooling and routing through Hyperdrive's edge network. So there's no single URL that can target production directly from drizzle-kit. That's intentional.

## Remote Doesn't Mean Production

This is important: `:remote` targets a **development branch** of your database, not production. If you use a database provider with branching — PlanetScale, Supabase, Neon — your Infisical `DATABASE_URL` should point to the dev branch. That's the whole point. You get a real Postgres environment with the same engine and extensions as production, but it's isolated. Schema changes on the dev branch don't touch production data.

The flow looks like this:

```
:local   → localhost Postgres       → your machine only
:remote  → dev branch Postgres      → shared dev environment
deploy   → Hyperdrive → production  → real users
```

Three environments, three levels of blast radius. `:local` can't break anything beyond your machine. `:remote` can break the shared dev branch but not production. And production is only reachable through Hyperdrive at runtime — no URL you can accidentally paste into a drizzle-kit command.

## The Contributor Experience

Someone clones the repo for the first time. They have no Infisical access. Here's all they need:

```bash
# Spin up local Postgres
docker run -d -p 5432:5432 -e POSTGRES_DB=epicenter postgres

# Push the schema locally
bun run db:push:local

# Start the dev server
bun run dev:local
```

Zero secrets. Zero environment setup. The `:local` scripts work because the fallback is hardcoded in `drizzle.config.ts`. They can develop locally, write migrations, and open PRs without ever touching Infisical.

When they need to test against the real dev database, they get Infisical access and switch to `:remote`. The workflow is the same, the scripts just have different names.

## The Pattern This Replaces

The old way looks like this:

```json
"scripts": {
    "db:push": "drizzle-kit push",
    "db:push:dev": "DATABASE_URL=$DEV_URL drizzle-kit push"
}
```

Problems here. Which `.env` is loaded? What's `$DEV_URL`? Is it set? Did someone source the wrong file? You end up with a mental checklist you have to run before every database command. You forget steps. Things break.

Or worse, there's just one script and the URL is controlled entirely by which `.env` file you have loaded. There's no signal in the command itself about what it targets.

## The Pattern That Works

```json
"db:push:local": "drizzle-kit push",
"db:push:remote": "infisical run --path=/api -- drizzle-kit push",
```

Now the command is self-documenting. `db:push:local` cannot accidentally hit the remote database — drizzle-kit will only see `LOCAL_DATABASE_URL`. `db:push:remote` cannot accidentally hit local — Infisical injects the real URL and that takes priority.

The suffix is not just a label. It enforces the behavior.

## Trade-offs

| Approach | Self-documenting | Blast radius explicit | Works without secrets |
|----------|------------------|-----------------------|-----------------------|
| Single script + `.env` | No | No | Depends on `.env` |
| Suffix convention | Yes | Yes | `:local` always works |

The one downside: you type more characters. `db:push:local` is longer than `db:push`. That's the whole trade-off. Given that the alternative is accidentally running a migration against a shared database, it seems worth it.

## The Golden Rule

**If a script connects to a database, the script name should tell you which one.**

Unsuffixed database commands are a footgun. You will forget which environment is active. The suffix isn't documentation — it's enforcement. `:local` scripts are wired to local Postgres. `:remote` scripts require secrets to run. The naming convention makes the blast radius visible before you hit enter.

---

_See also: [The Three Tiers of Database Latency](./database-latency-tiers.md) — where Hyperdrive fits in the latency picture_
