# content-vault — a reference-field example

A three-table vault that exercises Matter's row-level reference validator. It mirrors the
`pages → adaptations → publications` model: an adaptation points at the page it adapts, a
publication points at the adaptation it ships.

```
pages/          a source idea (no references)
adaptations/    page:       x-ref -> pages          one adaptation per (page, format)
publications/   adaptation: x-ref -> adaptations    one publication per (adaptation, platform)
```

A reference VALUE is the target row's **stem** (its filename without `.md`), the form you
write in frontmatter — e.g. `page: become-the-source` resolves to `pages/become-the-source.md`.

## Deliberately dangling references

Two rows point at stems that do not exist, so the validator has something to catch:

- `adaptations/orphan-adaptation.md` → `page: ghost-page` (no `pages/ghost-page.md`)
- `publications/stale-pub.md` → `adaptation: deleted-adaptation` (no such adaptation)

Every other field in those rows is valid, so single-folder `matter check` passes them — only
the cross-folder reference pass flags them.

## Run the cross-folder check

```bash
cd apps/matter
bun scripts/check-references.ts ../../examples/matter/content-vault
```

Expected: two `UNRESOLVED` findings (the two rows above).

Drop a folder to see the other finding kind — a reference whose target TABLE is gone, as
opposed to a target ROW:

```bash
# Checking adaptations without pages: page's target table isn't loaded.
mkdir -p /tmp/partial && cp -r adaptations /tmp/partial/
bun scripts/check-references.ts /tmp/partial   # -> MISSING_TARGET adaptations.page -> pages
```

## See it in the UI

The same vault is inlined at `apps/matter/src/routes/demo/references` (a Notion-like
relation view). `bun run dev`, then open `/demo/references`. The "Load pages folder" toggle
flips every `adaptations.page` relation between resolved and missing-target live.
