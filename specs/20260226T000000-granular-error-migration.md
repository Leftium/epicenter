# Granular Error Migration: API Change + Service-by-Service Migration

**Created**: 2026-02-26
**Status**: Partially superseded
**Supersedes**: `20260225T000000-tagged-error-redesign.md` (draft)
**Superseded by**: `20260226T233600-tagged-error-minimal-design.md` — Part 1 (wellcrafted API/type design) is replaced by the minimal design spec. Part 2 (service-by-service migration catalog) remains useful reference but call site targets should use flat props instead of nested `context`.
**Scope**: wellcrafted API change + all service error migrations in apps/whispering and apps/epicenter

## Summary

Two changes, shipped together in one PR:

1. **wellcrafted API**: Remove `message?: string` from `ErrorCallInput`. Make the factory input parameter optional when it resolves to `Record<never, never>` (no context, no cause).
2. **Application errors**: Break monolithic service errors into granular, failure-mode-specific errors with typed context. Migrate all call sites from `{ message: "..." }` to `{ context: { ... } }`.

## Part 1: wellcrafted API Change

### Current API (broken)

```typescript
type ErrorCallInput<TContext, TCause> =
  { message?: string }  // ← the escape hatch everyone uses
  & ContextFields<TContext>
  & CauseFields<TCause>;
```

Every call site passes `message:` directly, making `.withMessage()` templates dead code. The `message` field in `ErrorCallInput` undermines the entire structured context system.

### New API

```typescript
type ErrorCallInput<TContext, TCause> =
  ContextFields<TContext>
  & CauseFields<TCause>;
  // No message field. Template owns the message.
```

When `ErrorCallInput` resolves to `Record<never, never>` (no context, no cause), the factory parameter becomes optional:

```typescript
// Before: RecorderBusyErr({})
// After:  RecorderBusyErr()
RecorderBusyErr()  // no argument needed for static-message errors
```

### Files to change in wellcrafted

The wellcrafted package is published as `wellcrafted@0.31.0`. The source lives externally. Changes needed:

1. **`ErrorCallInput` type**: Remove `{ message?: string }` intersection
2. **`FinalFactories` type**: Make the `input` parameter optional when `ErrorCallInput<TContext, TCause>` extends `Record<never, never>`
3. **Runtime `errorConstructor`**: Remove `input.message ??` fallback — always call `fn(messageInput)`
4. **Handle optional input**: When input is omitted (undefined), pass `{ name }` to the template function

### Type change detail

```typescript
// Before
type FinalFactories<TName, TContext, TCause> = {
  [K in TName]: (input: ErrorCallInput<TContext, TCause>) => TaggedError<...>;
  [K in ReplaceErrorWithErr<TName>]: (input: ErrorCallInput<TContext, TCause>) => Err<TaggedError<...>>;
};

// After — input is optional when empty
type IsEmptyInput<TContext, TCause> =
  ErrorCallInput<TContext, TCause> extends Record<never, never> ? true : false;

type FinalFactories<TName, TContext, TCause> = {
  [K in TName]: IsEmptyInput<TContext, TCause> extends true
    ? (input?: ErrorCallInput<TContext, TCause>) => TaggedError<...>
    : (input: ErrorCallInput<TContext, TCause>) => TaggedError<...>;
  // Same for Err variant
};
```

### Runtime change

```typescript
// Before
const errorConstructor = (input) => ({
  name,
  message: input.message ?? fn(messageInput),  // escape hatch
  ...contextSpread,
  ...causeSpread,
});

// After
const errorConstructor = (input = {}) => ({
  name,
  message: fn({
    name,
    ...('context' in input ? { context: input.context } : {}),
    ...('cause' in input ? { cause: input.cause } : {}),
  }),
  ...('context' in input ? { context: input.context } : {}),
  ...('cause' in input ? { cause: input.cause } : {}),
});
```

---

## Part 2: Service-by-Service Migration

### Design principles (from the draft spec)

1. **Name errors by failure mode, not by service.** `RecorderBusyError`, not `RecorderServiceError`.
2. **Union type keeps the service name.** `type RecorderServiceError = RecorderBusyError | RecorderDeviceError | ...`
3. **Default to separate errors (Approach A).** Discriminate on `error.name`. Use union context (Approach B) only for 5+ variants that consumers rarely distinguish.
4. **Aim for 2-5 error types per service.** Don't create one error per call site — group by failure mode.
5. **Context must be JSON-serializable** (`JsonObject`). No `Date`, no `Error` instances, no class instances.
6. **Use `extractErrorMessage(error)` for caught unknown errors** — put the result in a `reason: string` context field, not in the message string.

### Three tiers of error complexity

**Tier 1: Static errors — no context, no arguments.** The error name + template IS the message. Use when there's no dynamic content.
```typescript
const { RecorderBusyError, RecorderBusyErr } = createTaggedError('RecorderBusyError')
  .withMessage(() => 'A recording is already in progress');
RecorderBusyErr()  // no argument needed
```

**Tier 2: Caught-error-only — `reason` carries `extractErrorMessage(error)`.** Use when the only dynamic content is the stringified caught error.
```typescript
const { PlaySoundError, PlaySoundErr } = createTaggedError('PlaySoundError')
  .withContext<{ reason: string }>()
  .withMessage(({ context }) => `Failed to play sound: ${context.reason}`);
PlaySoundErr({ context: { reason: extractErrorMessage(error) } })
```

**Tier 3: Structured data (with or without `reason`).** Use when there's domain-specific data worth preserving as named fields.
```typescript
const { ResponseError, ResponseErr } = createTaggedError('ResponseError')
  .withContext<{ status: number; reason?: string }>()
  .withMessage(({ context }) =>
    `HTTP ${context.status}${context.reason ? `: ${context.reason}` : ''}`
  );
ResponseErr({ context: { status: 404 } })                        // "HTTP 404"
ResponseErr({ context: { status: 500, reason: 'Internal error' } }) // "HTTP 500: Internal error"
```

### The `reason` convention

`reason` is a **reserved context field name** with a specific meaning: the output of `extractErrorMessage(error)` from a caught exception. It answers "why did this fail at a low level?"

- Don't use `reason` for domain-specific data — use named fields (`path`, `status`, `accelerator`, `id`)
- Don't use `reason` as the only context field when the error name already says enough — use Tier 1 instead
- Do use `reason` alongside named fields when you need both structured data and the caught error message

### Pattern to follow

The HTTP service is the model. It already uses the target pattern:

```typescript
// Definition
const { ConnectionError, ConnectionErr } = createTaggedError('ConnectionError')
  .withMessage(() => 'Failed to connect to the server');

const { ResponseError, ResponseErr } = createTaggedError('ResponseError')
  .withContext<{ status: number }>()
  .withMessage(({ context }) => `HTTP ${context.status} response`);

const { ParseError, ParseErr } = createTaggedError('ParseError')
  .withMessage(() => 'Failed to parse response body');

type HttpServiceError = ConnectionError | ResponseError | ParseError;

// Call sites
ConnectionErr()                              // static message, no args
ResponseErr({ context: { status: 404 } })    // structured context
ParseErr()                                    // static message, no args
```

---

### Migration catalog

For each service below: the current monolithic error, the proposed granular errors, and what call sites should look like after migration.

**Important**: The proposed errors below are suggestions based on analyzing current call sites. The implementing agent should read each file and may adjust error names, context types, or groupings based on what makes sense.

---

#### 1. RecorderServiceError (LARGEST — ~25 call sites)

**File**: `apps/whispering/src/lib/services/isomorphic/recorder/types.ts`
**Call sites**: `navigator.ts`, `desktop/recorder/cpal.ts`, `desktop/recorder/ffmpeg.ts`

**Current**:
```typescript
const { RecorderServiceError, RecorderServiceErr } = createTaggedError('RecorderServiceError')
  .withMessage(() => 'A recording operation failed');
```

**Proposed errors**:
```typescript
const { RecorderBusyError, RecorderBusyErr } = createTaggedError('RecorderBusyError')
  .withMessage(() => 'A recording is already in progress');

const { RecorderDeviceNotFoundError, RecorderDeviceNotFoundErr } = createTaggedError('RecorderDeviceNotFoundError')
  .withContext<{ selectedDeviceId: string | null }>()
  .withMessage(({ context }) =>
    context.selectedDeviceId
      ? `Could not find selected microphone '${context.selectedDeviceId}'. Make sure it's connected.`
      : 'No microphones found. Make sure a microphone is connected.'
  );

const { RecorderStartError, RecorderStartErr } = createTaggedError('RecorderStartError')
  .withContext<{ reason: string }>()
  .withMessage(({ context }) => `Failed to start recording: ${context.reason}`);

const { RecorderStopError, RecorderStopErr } = createTaggedError('RecorderStopError')
  .withContext<{ reason: string }>()
  .withMessage(({ context }) => `Failed to stop recording: ${context.reason}`);

const { RecorderFileError, RecorderFileErr } = createTaggedError('RecorderFileError')
  .withContext<{ operation: string; path?: string }>()
  .withMessage(({ context }) =>
    context.path
      ? `Failed to ${context.operation} recording file: ${context.path}`
      : `Failed to ${context.operation} recording file`
  );

const { RecorderDeviceEnumerationError, RecorderDeviceEnumerationErr } = createTaggedError('RecorderDeviceEnumerationError')
  .withMessage(() => 'Failed to enumerate recording devices');

type RecorderServiceError =
  | RecorderBusyError
  | RecorderDeviceNotFoundError
  | RecorderStartError
  | RecorderStopError
  | RecorderFileError
  | RecorderDeviceEnumerationError;
```

**Example call site migration**:
```typescript
// Before
RecorderServiceErr({ message: 'A recording is already in progress.' })
// After
RecorderBusyErr()

// Before
RecorderServiceErr({ message: `Failed to initialize the audio recorder. ${extractErrorMessage(error)}` })
// After
RecorderStartErr({ context: { reason: extractErrorMessage(error) } })

// Before
RecorderServiceErr({ message: `Unable to read recording file: ${error.message}` })
// After
RecorderFileErr({ context: { operation: 'read', path: filePath } })
```

---

#### 2. CompletionServiceError (~30 call sites)

**File**: `apps/whispering/src/lib/services/isomorphic/completion/types.ts`
**Call sites**: `anthropic.ts`, `groq.ts`, `google.ts`, `openai-compatible.ts`, `custom.ts`

**Current**:
```typescript
const { CompletionServiceError, CompletionServiceErr } = createTaggedError('CompletionServiceError')
  .withMessage(() => 'A completion operation failed');
```

**Proposed errors**: The completion providers have many call sites but the errors map well to HTTP status patterns. Use Approach B (union context) here since there are many variants and consumers rarely distinguish them — they just show the message.

```typescript
const { CompletionApiError, CompletionApiErr } = createTaggedError('CompletionApiError')
  .withContext<{ provider: string; statusCode: number; reason: string }>()
  .withMessage(({ context }) =>
    `${context.provider} API error (${context.statusCode}): ${context.reason}`
  );

const { CompletionConnectionError, CompletionConnectionErr } = createTaggedError('CompletionConnectionError')
  .withContext<{ provider: string; reason: string }>()
  .withMessage(({ context }) =>
    `Failed to connect to ${context.provider}: ${context.reason}`
  );

const { CompletionConfigError, CompletionConfigErr } = createTaggedError('CompletionConfigError')
  .withContext<{ provider: string; reason: string }>()
  .withMessage(({ context }) =>
    `${context.provider} configuration error: ${context.reason}`
  );

type CompletionServiceError =
  | CompletionApiError
  | CompletionConnectionError
  | CompletionConfigError;
```

**Example call site migration**:
```typescript
// Before (in anthropic.ts, handling 401)
CompletionServiceErr({ message: 'Invalid API key. Check your Anthropic API key.' })
// After
CompletionApiErr({ context: { provider: 'Anthropic', statusCode: 401, reason: 'Invalid API key' } })

// Before (in openai-compatible.ts, handling connection error)
CompletionServiceErr({ message: `Failed to connect: ${extractErrorMessage(error)}` })
// After
CompletionConnectionErr({ context: { provider: providerName, reason: extractErrorMessage(error) } })
```

---

#### 3. DbServiceError (~60+ call sites)

**File**: `apps/whispering/src/lib/services/isomorphic/db/types.ts`
**Call sites**: `desktop.ts`, `web.ts`, `file-system.ts`, `actions.ts`

**Current**:
```typescript
const { DbServiceError, DbServiceErr } = createTaggedError('DbServiceError')
  .withMessage(() => 'A database operation failed');
```

**Proposed errors**: The DB service has the most call sites. Most are CRUD operations that fail. Group by failure mode, not by table.

```typescript
const { DbNotFoundError, DbNotFoundErr } = createTaggedError('DbNotFoundError')
  .withContext<{ table: string; id: string }>()
  .withMessage(({ context }) => `${context.table} '${context.id}' not found`);

const { DbQueryError, DbQueryErr } = createTaggedError('DbQueryError')
  .withContext<{ operation: string; table: string; reason: string }>()
  .withMessage(({ context }) =>
    `Database ${context.operation} on ${context.table} failed: ${context.reason}`
  );

const { DbConnectionError, DbConnectionErr } = createTaggedError('DbConnectionError')
  .withContext<{ reason: string }>()
  .withMessage(({ context }) => `Database connection failed: ${context.reason}`);

const { DbMigrationError, DbMigrationErr } = createTaggedError('DbMigrationError')
  .withContext<{ reason: string }>()
  .withMessage(({ context }) => `Database migration failed: ${context.reason}`);

type DbServiceError =
  | DbNotFoundError
  | DbQueryError
  | DbConnectionError
  | DbMigrationError;
```

**Note**: With 60+ call sites across 3 implementations (desktop, web, file-system), this is the largest migration. The implementing agent should:
1. Read each file completely before starting
2. Identify the actual failure modes (many will map to `DbQueryErr`)
3. Not force granularity — if a call site is a generic "this DB operation failed," `DbQueryErr` is fine

---

#### 4. FsServiceError (3 call sites)

**File**: `apps/whispering/src/lib/services/desktop/fs.ts`

**Current**:
```typescript
const { FsServiceError, FsServiceErr } = createTaggedError('FsServiceError')
  .withMessage(() => 'File system operation failed');
```

**Proposed errors**:
```typescript
const { FileReadError, FileReadErr } = createTaggedError('FileReadError')
  .withContext<{ path: string; reason: string }>()
  .withMessage(({ context }) => `Failed to read file '${context.path}': ${context.reason}`);

type FsServiceError = FileReadError;
// Expand union as more operations are added
```

**Call site migration**:
```typescript
// Before
FsServiceErr({ message: `Failed to read file as Blob: ${path}: ${extractErrorMessage(error)}` })
// After
FileReadErr({ context: { path, reason: extractErrorMessage(error) } })
```

---

#### 5. TextServiceError (~12 call sites)

**File**: `apps/whispering/src/lib/services/isomorphic/text/types.ts`
**Call sites**: `desktop.ts`, `extension.ts`, `web.ts`

**Current**:
```typescript
const { TextServiceError, TextServiceErr } = createTaggedError('TextServiceError')
  .withMessage(() => 'Text service operation failed');
```

**Proposed errors**:
```typescript
const { ClipboardReadError, ClipboardReadErr } = createTaggedError('ClipboardReadError')
  .withContext<{ reason: string }>()
  .withMessage(({ context }) => `Failed to read from clipboard: ${context.reason}`);

const { ClipboardWriteError, ClipboardWriteErr } = createTaggedError('ClipboardWriteError')
  .withContext<{ reason: string }>()
  .withMessage(({ context }) => `Failed to copy to clipboard: ${context.reason}`);

const { TextInsertError, TextInsertErr } = createTaggedError('TextInsertError')
  .withContext<{ reason: string }>()
  .withMessage(({ context }) => `Failed to insert text: ${context.reason}`);

const { KeystrokeSimulationUnsupportedError, KeystrokeSimulationUnsupportedErr } = createTaggedError('KeystrokeSimulationUnsupportedError')
  .withMessage(() => 'Simulating keystrokes is not supported on this platform');

type TextServiceError =
  | ClipboardReadError
  | ClipboardWriteError
  | TextInsertError
  | KeystrokeSimulationUnsupportedError;
```

---

#### 6. NotificationServiceError (4 call sites)

**File**: `apps/whispering/src/lib/services/isomorphic/notifications/types.ts`
**Call sites**: `desktop.ts`, `web.ts`

**Current**:
```typescript
const { NotificationServiceError, NotificationServiceErr } = createTaggedError('NotificationServiceError')
  .withMessage(() => 'Notification operation failed');
```

**Proposed errors**:
```typescript
const { NotificationSendError, NotificationSendErr } = createTaggedError('NotificationSendError')
  .withContext<{ reason: string }>()
  .withMessage(({ context }) => `Failed to send notification: ${context.reason}`);

const { NotificationRemoveError, NotificationRemoveErr } = createTaggedError('NotificationRemoveError')
  .withContext<{ id: number; reason: string }>()
  .withMessage(({ context }) => `Failed to remove notification ${context.id}: ${context.reason}`);

type NotificationServiceError = NotificationSendError | NotificationRemoveError;
```

---

#### 7. PermissionsServiceError (4 call sites)

**File**: `apps/whispering/src/lib/services/desktop/permissions.ts`

**Current**:
```typescript
const { PermissionsServiceError, PermissionsServiceErr } = createTaggedError('PermissionsServiceError')
  .withMessage(() => 'Permissions check failed');
```

**Proposed errors**:
```typescript
const { PermissionCheckError, PermissionCheckErr } = createTaggedError('PermissionCheckError')
  .withContext<{ permission: 'accessibility' | 'microphone'; reason: string }>()
  .withMessage(({ context }) =>
    `Failed to check ${context.permission} permission: ${context.reason}`
  );

const { PermissionRequestError, PermissionRequestErr } = createTaggedError('PermissionRequestError')
  .withContext<{ permission: 'accessibility' | 'microphone'; reason: string }>()
  .withMessage(({ context }) =>
    `Failed to request ${context.permission} permission: ${context.reason}`
  );

type PermissionsServiceError = PermissionCheckError | PermissionRequestError;
```

---

#### 8. AutostartServiceError (3 call sites)

**File**: `apps/whispering/src/lib/services/desktop/autostart.ts`

**Proposed errors**:
```typescript
const { AutostartError, AutostartErr } = createTaggedError('AutostartError')
  .withContext<{ operation: 'check' | 'enable' | 'disable'; reason: string }>()
  .withMessage(({ context }) =>
    `Failed to ${context.operation} autostart: ${context.reason}`
  );

type AutostartServiceError = AutostartError;
```

**Note**: Only 3 call sites, all the same pattern. One error with a union context `operation` field is sufficient — don't over-split.

---

#### 9. CommandServiceError (2 call sites)

**File**: `apps/whispering/src/lib/services/desktop/command.ts`

**Proposed errors**:
```typescript
const { CommandExecutionError, CommandExecutionErr } = createTaggedError('CommandExecutionError')
  .withContext<{ command: string; reason: string }>()
  .withMessage(({ context }) =>
    `Failed to execute command '${context.command}': ${context.reason}`
  );

type CommandServiceError = CommandExecutionError;
```

---

#### 10. FfmpegServiceError (defined, but check call sites)

**File**: `apps/whispering/src/lib/services/desktop/ffmpeg.ts`

Analyze actual call sites. If FFmpeg is only used for audio compression, a single error may suffice:

```typescript
const { FfmpegError, FfmpegErr } = createTaggedError('FfmpegError')
  .withContext<{ operation: string; reason: string }>()
  .withMessage(({ context }) => `FFmpeg ${context.operation} failed: ${context.reason}`);

type FfmpegServiceError = FfmpegError;
```

---

#### 11. GlobalShortcutServiceError + InvalidAcceleratorError (4 call sites)

**File**: `apps/whispering/src/lib/services/desktop/global-shortcut-manager.ts`

Already somewhat granular. Refine:

```typescript
const { InvalidAcceleratorError, InvalidAcceleratorErr } = createTaggedError('InvalidAcceleratorError')
  .withContext<{ accelerator: string }>()
  .withMessage(({ context }) =>
    `Invalid accelerator format: '${context.accelerator}'. Must follow Electron accelerator specification.`
  );

const { ShortcutRegistrationError, ShortcutRegistrationErr } = createTaggedError('ShortcutRegistrationError')
  .withContext<{ accelerator: string; reason: string }>()
  .withMessage(({ context }) =>
    `Failed to register shortcut '${context.accelerator}': ${context.reason}`
  );

const { ShortcutUnregistrationError, ShortcutUnregistrationErr } = createTaggedError('ShortcutUnregistrationError')
  .withContext<{ accelerator?: string; reason: string }>()
  .withMessage(({ context }) =>
    context.accelerator
      ? `Failed to unregister shortcut '${context.accelerator}': ${context.reason}`
      : `Failed to unregister all shortcuts: ${context.reason}`
  );

type GlobalShortcutServiceError =
  | InvalidAcceleratorError
  | ShortcutRegistrationError
  | ShortcutUnregistrationError;
```

---

#### 12. DownloadServiceError (4 call sites)

**File**: `apps/whispering/src/lib/services/isomorphic/download/types.ts`
**Call sites**: `desktop.ts`, `web.ts`

```typescript
const { DownloadSaveError, DownloadSaveErr } = createTaggedError('DownloadSaveError')
  .withContext<{ reason: string }>()
  .withMessage(({ context }) => `Failed to save download: ${context.reason}`);

const { DownloadPathError, DownloadPathErr } = createTaggedError('DownloadPathError')
  .withMessage(() => 'No save path specified');

type DownloadServiceError = DownloadSaveError | DownloadPathError;
```

---

#### 13. PlaySoundServiceError (1 call site)

**File**: `apps/whispering/src/lib/services/isomorphic/sound/types.ts`

```typescript
const { PlaySoundError, PlaySoundErr } = createTaggedError('PlaySoundError')
  .withContext<{ reason: string }>()
  .withMessage(({ context }) => `Failed to play sound: ${context.reason}`);

type PlaySoundServiceError = PlaySoundError;
```

---

#### 14. DeviceStreamServiceError (local, in device-stream.ts)

**File**: `apps/whispering/src/lib/services/isomorphic/device-stream.ts`

```typescript
const { DeviceStreamError, DeviceStreamErr } = createTaggedError('DeviceStreamError')
  .withContext<{ reason: string }>()
  .withMessage(({ context }) => `Failed to acquire device stream: ${context.reason}`);

type DeviceStreamServiceError = DeviceStreamError;
```

---

#### 15. AnalyticsServiceError (check if any call sites exist)

**File**: `apps/whispering/src/lib/services/isomorphic/analytics/types.ts`

May have zero call sites. If so, keep simple:

```typescript
const { AnalyticsError, AnalyticsErr } = createTaggedError('AnalyticsError')
  .withContext<{ reason: string }>()
  .withMessage(({ context }) => `Failed to log analytics event: ${context.reason}`);

type AnalyticsServiceError = AnalyticsError;
```

---

#### 16. OsServiceError (check call sites)

**File**: `apps/whispering/src/lib/services/isomorphic/os/types.ts`

Check usage. If minimal:

```typescript
const { OsServiceError, OsServiceErr } = createTaggedError('OsServiceError')
  .withContext<{ operation: string; reason: string }>()
  .withMessage(({ context }) => `OS ${context.operation} failed: ${context.reason}`);
```

---

#### 17. LocalShortcutServiceError (check call sites)

**File**: `apps/whispering/src/lib/services/isomorphic/local-shortcut-manager.ts`

Check usage and apply same pattern as global shortcut service.

---

#### 18. SetTrayIconServiceError (internal, 1 call site)

**File**: `apps/whispering/src/lib/services/desktop/tray.ts`

```typescript
const { SetTrayIconError, SetTrayIconErr } = createTaggedError('SetTrayIconError')
  .withContext<{ reason: string }>()
  .withMessage(({ context }) => `Failed to set tray icon: ${context.reason}`);
```

---

#### 19. TransformServiceError (in query layer)

**File**: `apps/whispering/src/lib/query/isomorphic/transformer.ts`

Check call sites and apply appropriate granularity.

---

#### 20. StaticWorkspaceError (in epicenter app)

**File**: `apps/epicenter/src/lib/workspaces/static/queries.ts`

```typescript
const { StaticWorkspaceError, StaticWorkspaceErr } = createTaggedError('StaticWorkspaceError')
  .withContext<{ reason: string }>()
  .withMessage(({ context }) => `Static workspace error: ${context.reason}`);
```

---

#### 21. WorkspaceError (in epicenter app)

**File**: `apps/epicenter/src/lib/workspaces/dynamic/queries.ts`

Check call sites. If mostly generic failures:

```typescript
const { WorkspaceError, WorkspaceErr } = createTaggedError('WorkspaceError')
  .withContext<{ operation: string; reason: string }>()
  .withMessage(({ context }) => `Workspace ${context.operation} failed: ${context.reason}`);
```

---

#### 22. ExtensionError (in epicenter package)

**File**: `packages/epicenter/src/shared/errors.ts`

Already has `.withContext<ExtensionErrorContext | undefined>()`. Review and refine.

---

#### 23. ParseJsonError (in svelte-utils)

**File**: `packages/svelte-utils/src/createPersistedState.svelte.ts`

```typescript
const { ParseJsonError, ParseJsonErr } = createTaggedError('ParseJsonError')
  .withContext<{ preview: string }>()
  .withMessage(({ context }) => `Failed to parse JSON: "${context.preview}..."`);
```

---

#### 24. HttpServiceError (already done — the model)

**File**: `apps/whispering/src/lib/services/isomorphic/http/types.ts`

Already uses the target pattern. Only change: remove `message` overrides from call sites in `desktop.ts` and `web.ts`.

```typescript
// Before (in desktop.ts)
ConnectionErr({ message: `Failed to establish connection: ${extractErrorMessage(error)}` })
// After — with API change, ConnectionErr has no message field
// Option 1: Add context to ConnectionError
// Option 2: Keep static message, the detail is in the error chain

// Before
ResponseErr({ message: extractErrorMessage(await response.json()), context: { status: response.status } })
// After — message comes from template
ResponseErr({ context: { status: response.status } })
// If we need the response body info, add it to context:
// .withContext<{ status: number; reason?: string }>()
```

The HTTP service needs review: `ConnectionError` and `ParseError` currently have static messages but call sites override with dynamic messages. Either add context to carry the detail, or accept the static message is sufficient (the original error is typically logged separately).

---

## Part 3: Skills to Update

After migration, update these skills:

1. **`.agents/skills/services-layer/SKILL.md`**: Replace all `{ message: "..." }` examples with `{ context: { ... } }`. Show the granular error pattern as the default.
2. **`.agents/skills/error-handling/SKILL.md`**: Update trySync/tryAsync examples to use structured context instead of message strings.
3. **`.agents/skills/create-tagged-error/SKILL.md`** (if it exists): Update API reference.

---

## Implementation Order

1. **Publish new wellcrafted version** with `message` removed from `ErrorCallInput` and optional input parameter
2. **Update wellcrafted dependency** in the monorepo
3. **Migrate services** — can be done in parallel per service, but commit atomically:
   - Start with **HttpService** (already close, just remove message overrides)
   - Then **FsService** (3 call sites, easy win)
   - Then **TextService**, **NotificationService**, **PermissionsService** (small services)
   - Then **CompletionService** (~30 call sites)
   - Then **RecorderService** (~25 call sites)
   - Then **DbService** (~60 call sites, largest)
   - Then remaining small services
4. **Update skills** after all services are migrated
5. **Type check**: `bun run typecheck` must pass
6. **Build**: `bun run build` must pass

## Notes for Implementing Agent

- The proposed error types above are **suggestions**. Read each service file completely before deciding on the final error types. The actual failure modes in the code may differ from what's predicted here.
- When in doubt, fewer error types is better. Don't create an error type that has only 1 call site unless it represents a genuinely distinct failure mode that callers handle differently.
- The `reason: string` context field is a **reserved convention** meaning "the output of `extractErrorMessage(error)`." Use it when you need to capture a caught exception's message. Don't use it for domain-specific data — use named fields like `{ path: string }` or `{ status: number }` instead. Don't add `reason` when the error name already says enough — use Tier 1 (static, no context) instead.
- Many existing error messages are user-facing and well-written. Preserve that quality in the `.withMessage()` templates — don't make messages worse in the name of structure.
- The `type XServiceError = A | B | C` union must be exported and used in the service's return type signatures. Verify that `Result<T, XServiceError>` still works with the new union type in all service method signatures.
