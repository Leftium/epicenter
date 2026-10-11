Claude Opus 5.5, read-only review. Session `4d67a881-e20e-4306-a984-5bf3bd34d1fe`. The original file inventory is placed before the analysis below.

```
.review/
|-- tests-final.log          (grep: totals + retained-files test names)
`-- types-final.log
apps/honeycrisp/
|-- evidence/deep-collapse/native-evidence.json
|-- host/serve.test.ts       (:870-1084)
`-- src/
    |-- lib/
    |   |-- notes.svelte.ts  (:228-487, :630-789)
    |   |-- bridge/contract.ts      (:1-85)
    |   |-- bridge/notes-host.ts    (grep: snapshot handling)
    |   `-- platform/types.ts       (:1-40)
    `-- routes/components/
        |-- FileNameBar.svelte      (:1-50)
        `-- FileBrowser.svelte      (:143-192)
```

# Repair recheck: all five findings and the transport concern are closed in the current source

I found no remaining regression attributable to this diff. This is from reading only; I ran nothing, and I did not re-read the full `tests-final.log` or the rest of `serve.test.ts` beyond the four new tests.

## Newly read files



## Per-finding verdict

| Finding | Status | What I checked |
|---|---|---|
| F1 raw delete | Fixed | `deletionFor` at `notes.svelte.ts:743-746` uses the same predicate as `rename`, so the raw branch at `:752-756` is live again. Tests at `serve.test.ts:878` and `:898` cover edited delete and stale-capture refusal. |
| F2 stale listing | Fixed | `accepted` is snapshotted at `:252-256` and checked before and after the read at `:299` and `:316`. Every path that changes `accepted` mid-pass either triggers a follow-up refresh or leaves the draft at a state it already observed, so a skipped observation loses nothing. The test at `serve.test.ts:995` asserts no transient rollback. |
| F3 destination draft | Fixed | The preflight at `:678-679` runs before either rename route. Raw and note tests at `serve.test.ts:1036` and `:1058`. |
| F4 identity and selection | Fixed | The identity check is hoisted to `:293`. Missing non-text entries use `openFiles.delete` at `:296`, so `selectedPath` survives and the missing-file screen is reachable again. |
| F5 allowlist | Fixed | `NotesFolder` picks its keys from `FOLDER_METHODS` (`types.ts:22-35`). `BridgeEvent.snapshot` is `GitSnapshot` and the cast in `notes-host.ts:88` is gone. |
| Transport throw | Fixed for rename and create | `FileBrowser.svelte:155-177` and `FileNameBar.svelte:33-42` catch, toast, and clear the busy flag in `finally`. |

Your declined items (no forwarding factory, no table-save bypass, no `readonly` on the top-level members) are reasonable; none was a correctness finding.

## Residual notes, none blocking

- **Preflight on a clean stale draft (this diff, low).** If a clean draft sits at the destination and its file was removed externally but no refresh has run yet, the rename is refused with "save or discard it", and there is no discard control for a clean draft. The next watcher or focus refresh forgets that draft, so it clears itself.
- **Delete during a transport failure (baseline, low).** `confirmDelete` in `file-actions.ts` still has no catch around `deletionFor` (raw `files.read`) or `remove`, so it fails silently with an unhandled rejection. No busy state gets stuck. This is from my earlier read of `file-actions.ts`; I did not re-read it this round.
- **Nits.** `FolderCallPath` still spells the git methods literally at `contract.ts:25` and `:49`; drift there is a compile error in `notes-host.ts`, so it is safe. The `FileBrowser` catch says "Could not change the file name" for create failures too.

## Missing correctness evidence

- **F4 has no test.** Nothing covers a binary or failed entry removed externally keeping the missing-file screen, or the hoisted identity check.
- **Loading-identity abandonment is still untested.** Open a path, rename or delete it mid-read, release the read: the stale read should not resurrect an entry.
- **The catch/finally UI paths have no test.**
- **Native evidence does not cover the repairs.** `evidence/deep-collapse/native-evidence.json` lists raw rename, metadata, conflict, and a clean quit. It has no raw delete, no refused rename onto a retained draft, and no missing-file screen, so I cannot tell whether it predates the repairs. The final native recheck should exercise at least the raw delete.
- **Logs.** `tests-final.log` shows 167 pass, 0 fail, with the five new retained-files tests present. `types-final.log` shows both svelte-check runs at 0 errors and 0 warnings; the scripts `tsc` step leaves no output on success, so the log is consistent with a pass but does not itself show it.
