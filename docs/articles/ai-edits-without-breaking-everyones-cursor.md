# Keep AI Edits Local Until the Human Says Go

**TL;DR: Use a private preview layer for AI edits in collaborative editors.** AI changes stay local while other users' edits keep syncing, then apply as normal transactions only after review.

> "The AI should propose, not impose. Show me the diff, let me think, then I'll decide."

## The Problem

You're building a collaborative editor backed by Yjs. Every keystroke syncs to all users instantly. That's the magic of CRDTs.

Now you want to add an AI copilot. User clicks "rewrite this section," and the AI goes to work. Here's what happens if you implement the naive way:

```typescript
// ❌ This breaks collaboration
async function applyAIEdit(yText, range, prompt) {
  const result = await callAI(prompt);
  yText.delete(range.start, range.length);
  yText.insert(range.start, result);
  // Everyone sees this immediately. No review. No undo.
}
```

The AI replaces their paragraph. It syncs. Now everyone in the document sees AI-generated text they never reviewed. User B, who was editing the next paragraph, looks up and sees half the doc rewritten. Their cursor might be in a different place. The context they were working with just vanished.

This isn't how humans collaborate. You don't let someone else push to your document without review. Why would you let AI?

## The Private Preview Layer

The pattern that works: AI changes exist only on the requesting user's machine until they explicitly accept. Other users' edits keep flowing through, reflected in the preview. This is what Liveblocks calls the "private preview layer."

Here's the flow:

```
User A (with AI)          Yjs Doc           User B
    │                        │                │
    │  invoke AI copilot     │                │
    │  [editor→read-only]    │                │
    │  [diff view renders]   │                │
    │                        │                │
    │  AI changes compute    │                │
    │  (local only, not Yjs) │                │
    │                        │                │
    │                        │←───User B edit─┤
    │  (B's edit syncs       │                │
    │   and shows in diff)   │                │
    │                        │                │
    │  User A: "Accept"      │                │
    │──────AI changes────────>│────────────────>│
    │  (applied as normal    │  (B sees the   │
    │   Yjs transactions)    │   final edit)  │
    │                        │                │
```

User A's editor switches to a read-only diff view. The AI-generated changes render as additions and deletions, but they're not in the Yjs document. They're UI-only. Meanwhile, User B keeps editing. Their changes sync normally through Yjs and appear in User A's diff view. The diff computes against the live document state, not a frozen snapshot.

When User A clicks Accept, the AI changes apply as regular Yjs transactions, authored by User A. Everyone sees them at that moment, just like any other edit. If User A clicks Reject, nothing happens. The local preview discards. No one else ever knew AI was involved.

## Why This Works

The insight: **treat AI like a draft collaborator**. In code review, you don't push directly to main. You open a PR. Someone reviews, requests changes, and eventually merges. Same principle here.

The Yjs document is your main branch. The private preview layer is your PR. Other people's commits keep landing on main while your PR is open. When you merge, you rebase against the current state and apply your changes.

This has a second benefit: you can iterate with the AI. User sees the preview, doesn't like it, chats with the copilot ("make it shorter," "add an example"), gets a new preview. All local. All private. Only the final version hits shared state.

## Implementation Details

The diff view is a custom renderer in the editor, not a special mode on the server. The Yjs document keeps updating. Your renderer compares the live document against the proposed AI changes and renders the diff. When User B makes an edit that conflicts with the AI's proposed change, you recompute the diff. User A sees the conflict before accepting.

```typescript
// ✅ AI changes stay local
class PrivatePreviewLayer {
  constructor(yText, editor) {
    this.yText = yText;
    this.editor = editor;
    this.proposedChanges = null;
  }

  async preview(range, prompt) {
    this.editor.setReadOnly(true);
    this.proposedChanges = await callAI(prompt, this.getCurrentText(range));
    this.renderDiff(range, this.proposedChanges);

    // Listen for remote changes
    this.yText.observe(() => this.recomputeDiff(range));
  }

  accept() {
    // Apply as normal Yjs transactions
    this.yText.delete(range.start, range.length);
    this.yText.insert(range.start, this.proposedChanges);
    this.cleanup();
  }

  reject() {
    // Just discard, nothing to undo in Yjs
    this.cleanup();
  }
}
```

The editor component handles the UI: syntax highlighting for additions and deletions, a chat interface for iteration, Accept/Reject buttons. The Yjs document doesn't know or care. It keeps syncing updates like always.

## WebSockets vs HTTP for AI

You need bidirectional communication. The AI might need to call tools, ask for confirmation, or stream partial results. HTTP streaming is one-way: server to client. You'd have to hack around it with polling or separate request channels.

WebSockets give you a persistent connection. Client sends a prompt. AI responds with a stream. Mid-stream, AI realizes it needs to call a function to fetch data. It sends a tool call message. Client responds with the result. AI continues. All over the same socket.

```typescript
// WebSocket enables back-and-forth
socket.on('ai-stream', (chunk) => updatePreview(chunk));
socket.on('tool-call', (tool, args) => {
  const result = executeToolLocally(tool, args);
  socket.emit('tool-result', result);
});
```

With HTTP, you'd need separate requests or long-polling hacks. WebSockets were built for this.

## When Not to Use This

If your AI is doing autocomplete or inline suggestions (think Copilot in VSCode), you don't need this pattern. Those are speculative, ephemeral UI. They disappear if you ignore them. The private preview layer is for substantial changes: rewrites, expansions, restructuring. Changes where the user needs to see a before/after diff.

Also, if you're not building a collaborative editor, you don't have this problem. Single-user document editors can apply AI changes directly and rely on undo. The complexity here is all about not disrupting other people.

## Comparison Table

| Approach           | Other Users Disrupted | Review Before Apply | Handles Concurrent Edits |
|--------------------|-----------------------|---------------------|--------------------------|
| Direct Yjs edits   | Yes (immediate sync)  | No                  | Yes (CRDTs merge)        |
| Private preview    | No (local only)       | Yes                 | Yes (diff recomputes)    |
| Locked mode        | Yes (blocks editing)  | Yes                 | No (frozen during AI)    |

Locked mode is where you disable editing for everyone while AI works. Don't do that. It defeats the point of real-time collaboration.

## The Golden Rule

**Metadata static, execution dynamic.** Wait, wrong rule. Here's the right one:

**AI should never write to shared state without human approval.** Preview locally, accept explicitly, then sync.

This extends beyond text editors. Any collaborative tool with AI features: design tools, spreadsheets, whiteboards. If multiple people are working in the same space, AI should propose changes in a private layer. The human reviews, iterates, and commits. That's the only way to keep the collaborative experience smooth.

You can read Liveblocks' full implementation writeup at https://liveblocks.io/blog/building-an-ai-copilot-inside-your-tiptap-text-editor. They built this pattern for TipTap, but it applies to any Yjs-backed editor.

The insight isn't about Yjs or CRDTs specifically. It's about respecting the collaborative space. AI is a powerful tool. It's also an aggressive one. Give users the chance to say no before it touches their work.
