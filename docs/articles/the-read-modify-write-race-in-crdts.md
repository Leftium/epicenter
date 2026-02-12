# CRDTs Stop Concurrent Writes, But Not Your Agent's Stale Read

**TL;DR: CRDTs solve concurrent writes when operations express intent. But agents that read, think, and write back introduce a read-modify-write race that diffs can't fix.**

> The problem isn't the diff. It's that your agent computed its answer against a version of the document that no longer exists.

## The Problem

I was building an agent that edits a collaborative document. The agent reads the Y.Text, sends it to an LLM, gets back a modified version, and writes it back using `updateYTextFromString()`. The function diffs the current state against the desired output and applies the changes.

Sounds reasonable. CRDTs handle concurrent edits, right?

Here's what actually happens:

```
t=0s:   Agent reads Y.Text: "Hello World"
        Agent starts processing (LLM call, code generation, etc.)

t=15s:  User changes "World" to "Earth"
        Y.Text is now: "Hello Earth"

t=30s:  Agent finishes. Desired output: "Hello Beautiful World"
        Agent calls: updateYTextFromString(yText, "Hello Beautiful World")

        Inside the function:
        currentString = yText.toString()  →  "Hello Earth"  (includes user's change!)
        desired = "Hello Beautiful World"

        diffChars("Hello Earth", "Hello Beautiful World"):
          keep "Hello "
          delete "Earth"          ← undoes user's edit
          insert "Beautiful World"

        Result: "Hello Beautiful World"
        User's "Earth" edit is gone
```

The user's change got silently overwritten. Not because the diff failed, but because the agent's desired output was computed against stale state.

## Why This Happens

CRDTs solve concurrent writes when operations express **intent**: "insert 'Beautiful' at position 6." Two agents can insert at different positions, and the CRDT merges them correctly.

But `updateYTextFromString()` doesn't express intent. It expresses **desired end state**: "make the document look exactly like this string." The function has no idea what the agent was trying to do. It just knows: current state is X, desired state is Y, compute the diff.

When the current state includes edits that arrived during the agent's think time, those edits get diffed away.

## The Race Window

```
Agent Thread:                  User Thread:
─────────────────────────────────────────────────────
t=0s:  read("Hello World")
       ↓
       [30 seconds of LLM processing]
       ↓                        t=15s: edit "World" → "Earth"
t=30s: updateYTextFromString()
       ├─ read current state   ← sees "Hello Earth"
       ├─ diff vs desired
       └─ apply changes        ← overwrites "Earth"
```

The race is between the agent's initial read at t=0s and the function's read at t=30s. The longer the agent thinks, the wider the window.

## Not a Diffing Bug

This isn't a problem with `diffChars()`. The function is atomic: JavaScript is single-threaded, the `doc.transact()` block runs synchronously. No remote changes arrive between `toString()` and applying the diff.

The function did exactly what it was asked: "make Y.Text equal this string." The problem is upstream. The agent generated that string against a document snapshot that's 30 seconds stale.

## What Survives

The diff does narrow the damage. Only overlapping edits get overwritten:

| Agent's Change | User's Change | Result |
|----------------|---------------|--------|
| "Hello" → "Hi" | "World" → "Earth" | Both survive (non-overlapping) |
| "World" → "Beautiful World" | "World" → "Earth" | Agent wins (overlapping) |
| No change to "World" | "World" → "Earth" | User survives (no conflict) |

If the agent only edits the first paragraph and the user only edits the second, both changes survive. The race only matters when edits touch the same region during the think window.

## Mitigation Strategies

### Re-read Before Writing

The agent re-reads Y.Text right before calling `updateYTextFromString()`:

```typescript
// At t=0s
const initialContent = yText.toString();

// Send to LLM, get back modified content
const agentOutput = await llm.generate(initialContent);

// At t=30s, re-read before writing
const currentContent = yText.toString();
if (currentContent !== initialContent) {
  // State changed during processing. Recompute? Warn user? Abort?
}

updateYTextFromString(yText, agentOutput);
```

This shrinks the window but doesn't eliminate it. Changes can still arrive between the re-read and the update. You've reduced the race from 30 seconds to milliseconds, but it's still there.

### Accept the Limitation

For most use cases, this is fine:

- If the user isn't actively editing, there's no race
- If edits don't overlap, both survive
- If the agent runs quickly (streaming responses, local models), the window is small

The problem matters when you have:
- Long-running agent operations (30+ seconds)
- Active concurrent editing
- Edits in the same document region

In that scenario, you're fighting the fundamental constraint: the agent's output represents a transformation of stale state.

### Express Intent, Not End State

The real solution is to teach the agent to express intent:

```typescript
// Instead of: "make the document look like this"
updateYTextFromString(yText, finalString);

// Express: "here's what I want to change"
const operations = [
  { type: 'insert', position: 6, text: 'Beautiful ' },
  { type: 'delete', position: 12, length: 5 }  // Delete "World"
];
applyOperations(yText, operations);
```

Now the agent says "insert 'Beautiful' before 'World'" instead of "make it 'Hello Beautiful World'." The CRDT can merge that intent with concurrent edits.

But this requires the agent to think in terms of operations, not end states. Most LLMs output full documents, not diffs. You'd need to diff the agent's output against its input to recover intent, which brings you back to the same problem.

## The Pattern

This is the classic read-modify-write race in distributed systems:

1. Read current state
2. Compute new state based on what you read
3. Write new state back

Between steps 1 and 3, the world moved. Your computation is based on a version of reality that no longer exists.

CRDTs don't solve this. They solve a different problem: merging concurrent writes when each write expresses independent intent. An agent that reads, thinks for 30 seconds, and writes back isn't expressing independent intent. It's expressing "here's what the document should look like, given what I read 30 seconds ago."

## Golden Rule

**CRDTs merge intents, not desired outcomes. If your operation means "make it look like this," you've reintroduced the race.**

---

## Related

- [Diff-Based Sync Guesses Intent, CRDT Operations Express It](./diff-reconciliation-is-not-a-crdt-operation.md): The function that does the guessing
- [The Blast Radius of Conflict](./blast-radius-of-conflict-character-diff-vs-document-replace.md): How much damage the race actually causes
- [Clear-and-Rebuild Is the Real CRDT Violation](./clear-and-rebuild-is-the-real-crdt-violation.md): The alternative that loses everything, not just overlapping edits
