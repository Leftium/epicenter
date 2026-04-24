---
name: one-sentence-reduction
description: Strip the docs and prose away and describe what something actually does in one sentence—then re-check under the defaults actually in use. Use proactively when evaluating an abstraction, a wrapper, a flag, an endpoint, or any surface where docs might be masking what's really happening. Also triggers when the user asks "what does X actually do" or when you're about to recommend adding a new layer.
metadata:
  author: epicenter
  version: '1.1'
---

# One-Sentence Reduction

Long docs can mask a thing doing less than it claims, or having defaults tuned for a case it's not being used for. The fix is a forced reduction: pretend the JSDoc, the README, and the clever name don't exist. Write what the code actually does in one sentence. Then write what it does **under the defaults actually in use**. Then ask whether the caller's use case needs that.

This applies to any surface with prose wrapped around it — utilities, wrappers, feature flags, config options, endpoints, even whole subsystems.

## When to Apply This Skill

**On request:**
- Evaluating whether an abstraction earns its keep
- Reviewing a wrapper around an existing utility
- Writing docs for something that feels over-documented

**Proactively (trigger without being asked):**
- Before recommending the user wrap, extend, or compose an existing utility — do the reduction first to check it's worth wrapping
- When reviewing your own just-written abstraction before sending it
- When code and docs seem to disagree, or docs describe capabilities you can't locate in the body
- When the user asks "what does X do" or "is this useful" — don't paraphrase the docs, do the reduction
- When a utility has impressive-sounding docs but you can't articulate in one sentence what the caller needs it for

## Show Your Work

The reduction is **not** a silent internal check. Write the three sentences out in your response so the user can push back on each one. The value is in the reader seeing the gap between what the prose claims and what the code actually does — that only happens if the reduction is visible.

## The Three Reductions

Do them in order. Don't skip.

1. **Strip-docs reduction.** Ignore the name, JSDoc, and README. Read the body. Finish this sentence in plain language: *"This function ______."* No adjectives. No "flexibly handles." Just the mechanics.

2. **Default-config reduction.** Now specialize: *"Under the defaults actually in use, this function ______."* Features gated behind non-default options don't count. If a knob is set to `Infinity`, `false`, or `null`, the code path it guards is inert.

3. **Caller-need check.** Does the caller's use case actually need the default-config version? If not, you've found a mismatch: either the wrong tool, or the wrong defaults, or a wrapper adding zero value.

## Worked Example

`createDocumentFactory` has a page of JSDoc about refcounted Y.Doc lifecycles, cache eviction, idle timeouts, and deterministic cleanup.

```
Strip-docs reduction:
  "Dedup by id, refcount open/close, destroy when refcount hits zero
   after an idle timeout."

Default-config reduction (idleTimeoutMs: Infinity):
  "Dedup by id. Close is explicit—docs live forever."
  → Refcount is inert. No eviction ever fires.

Caller-need check: wrapping the singleton openFuji with this.
  The caller has exactly one id and one lifetime. Dedup of a singleton
  is a no-op. Explicit close already exists on the underlying doc.
  Verdict: the wrapper contributes zero. Delete it.
```

The reduction did the work. The JSDoc had been hiding that the defaults neuter the main feature, and the caller didn't need the main feature anyway.

## Common Reveals

- **Inert knobs**: a default (`Infinity`, `false`, `null`) disables the mechanism the docs advertise.
- **Singleton wrappers**: dedup/cache utilities wrapped around a caller that only ever has one instance.
- **Ceremony with no payoff**: "lifecycle management" that reduces to "call close when done"—which the underlying type already supports.
- **Docs describing aspirations**: the prose describes what the abstraction *could* do under other configs, not what it does here.

## Anti-Patterns

- **Reading the JSDoc first and paraphrasing it.** That's not a reduction—it's a summary of the marketing. Read the body.
- **Stopping at reduction 1.** "It dedups and refcounts" sounds useful until you specialize to the config actually in use.
- **Defending the abstraction by listing features the caller doesn't use.** If the caller passes defaults that disable feature X, feature X is not a justification.

## Success Criteria

After the reduction, you can state in one sentence what the utility is buying this caller. If you can't—or the sentence is "nothing, really"—the abstraction doesn't earn its keep here.
