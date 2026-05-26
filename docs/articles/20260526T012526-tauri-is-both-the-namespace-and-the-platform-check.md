# `tauri` is both the namespace and the platform check

Every Tauri-specific capability in Whispering lives under one namespace, exported as `tauri` from `$lib/tauri`. On Tauri builds it's the full namespace. On web builds it's `null`. Same name, same import path, different runtime value.

That two-state shape is the whole point. The variable doubles as a boolean: if `tauri` is truthy you're on Tauri, and you also have the capability surface in the same expression.

```ts
import { tauri } from '$lib/tauri';

if (tauri) {
  await tauri.fs.pathToBlob(path);
}
```

One check answers two questions. Two birds, one variable.

## What we were doing before

The pattern this replaces shows up in almost every desktop-flavored UI codebase. You check the platform, then you act on the platform. Two separate steps, two places to forget either half:

```ts
import { isTauri } from '@tauri-apps/api/core';
import { FsServiceLive } from '$lib/services/fs';

if (isTauri()) {
  await FsServiceLive.pathToBlob(path);
}
```

The `isTauri()` answers "am I on Tauri?" The `FsServiceLive` answers "what can I call?" They're the same question. The codebase had two ways to ask it because the platform check and the capability surface were declared in different files, with different stories about what happens on the wrong platform.

`FsServiceLive` on web was a stub object that threw when called. The throw was unreachable in practice (because `isTauri()` was false), but the import path resolved, the call site type-checked, and the developer had to remember to wrap every site in the guard. Forget the guard, and at runtime you'd get an error like "Tauri-only service called from web bundle" inside a `try`/`catch` somewhere downstream.

Two guards for one fact. Either one alone would compile.

## The collapse

The namespace fixes both halves at once. The capability is `null` on web, so there's nothing to call. The platform check is the truthiness of `tauri`, so it's the same expression. If you forget the check, TypeScript catches you:

```ts
import { tauri } from '$lib/tauri';

await tauri.fs.pathToBlob(path);
//    ^ 'tauri' is possibly 'null'.
```

You can't write the unsafe version. The type forces you to narrow.

The narrowing then gives you both: you're on Tauri AND `tauri` is the namespace.

```ts
if (tauri) {
  // here, `tauri` is the full namespace, not `null`
  await tauri.fs.pathToBlob(path);
  await tauri.command.execute('open .');
  await tauri.rpc.autostart.enable();
}
```

Inside the `if`, every capability is reachable without re-checking. The branch is the boundary.

## How it's two files behind one import

Vite swaps the file at build time. `tauri.tauri.ts` is the real namespace. `tauri.browser.ts` is one line:

```ts
export const tauri = null;
```

`vite.config.ts` has:

```ts
resolve: {
  extensions: isTauri
    ? ['.tauri.ts', '.ts']
    : ['.browser.ts', '.ts'],
}
```

On Tauri builds, `import { tauri } from '$lib/tauri'` resolves to `tauri.tauri.ts`. On web, it resolves to `tauri.browser.ts`. The non-target file isn't bundled.

TypeScript needs the same trick for type-checking. `tsconfig.json`:

```json
"moduleSuffixes": [".tauri", ".browser", ""]
```

TS always reads `tauri.tauri.ts` for type information, regardless of build. The Tauri file exports the shape; the browser file just has to match at runtime.

So the consumer sees one type (`Tauri | null`) on both builds, and the runtime value follows the platform.

## Prop drilling: pushing the narrowing further

After you narrow `tauri` once, child components shouldn't have to re-narrow. The check has already happened. You can prop-drill the non-null reference:

```svelte
<!-- ParentPage.svelte -->
<script>
  import { tauri } from '$lib/tauri';
  import TauriOnlyContent from './TauriOnlyContent.svelte';
</script>

{#if tauri}
  <TauriOnlyContent {tauri} />
{/if}
```

```svelte
<!-- TauriOnlyContent.svelte -->
<script lang="ts">
  import type { Tauri } from '$lib/tauri';

  let { tauri }: { tauri: Tauri } = $props();
</script>

<button onclick={() => tauri.tray.setIcon('IDLE')}>Set tray</button>
```

The child takes `tauri: Tauri` (non-null) as a prop. The parent has already checked. No `tauri!` assertion inside the child, no re-check, no possibility of forgetting.

The pattern composes. Any child that needs Tauri capabilities declares it in its prop signature, and parents have to either be Tauri-only themselves or gate before rendering. The type system carries the invariant up the tree.

## When this doesn't fit: dual-implementation services

The namespace is for things that exist ONLY on Tauri. Some services exist on BOTH platforms with real implementations on each. Clipboard. Text. HTTP. Notifications. The web version reads `navigator.clipboard`, the Tauri version uses `@tauri-apps/plugin-clipboard-manager`.

Those don't go in the namespace. They get their own folder with `index.tauri.ts` and `index.browser.ts` files that both implement a shared interface:

```ts
// services/clipboard/index.browser.ts
import type { ClipboardService } from './types';

export const ClipboardServiceLive = {
  writeText: async (text) => navigator.clipboard.writeText(text),
} satisfies ClipboardService;
```

Consumer code doesn't know or care which version it gets:

```ts
import { ClipboardServiceLive } from '$lib/services/clipboard';
await ClipboardServiceLive.writeText('hello');
```

No `tauri?.` here. The whole point is that the capability exists on both platforms; the implementation differs but the call site doesn't. We covered this pattern in [Two files, one import](./20260525T234034-two-files-one-import-build-time-platform-injection.md).

The test for which pattern fits:

- **Capability exists on both, with different implementations?** Suffix DI. `services/<cap>/index.{tauri,browser}.ts`, shared interface, single consumer pattern.
- **Capability only exists on Tauri?** Namespace. `$lib/tauri` with `if (tauri)` or `tauri?.` at consumers.

Most apps want both patterns. They solve different problems.

## What lives in `tauri`

Today: file system, shell command execution, macOS permission flows, FFmpeg, system tray, global shortcuts, autostart. Plus a `tauri.rpc` sub-namespace with TanStack-wrapped variants for the subset that needs caching and reactive query state (autostart toggle, ffmpeg-installed check, etc).

Adding a new Tauri-only capability is one section in one file:

```ts
// tauri.tauri.ts
export const NewCapError = defineErrors({ ... });

const newCap = {
  doSomething: (arg: string) => tryAsync({ ... }),
};

const _tauri = {
  fs, command, /* ... */, newCap,
};
```

Consumers immediately see `tauri?.newCap.doSomething(arg)` with full type-checking. The web build doesn't ship any of the new code; on web, `tauri` is still just `null`.

## The thing I keep coming back to

The reason this pattern feels right is that the platform check and the capability surface stop being two separate concepts. They were already the same concept: "Tauri exists, and these are the things you can do with it." We used to spell them in two different files with two different import paths. Now they're one variable, and the question "should I do this on Tauri?" is the same question as "can I do this at all?"

The TypeScript narrowing gives us the rest for free. You can't call into the namespace without first asking the platform question, because the question and the answer are the same expression.

## If you want to see the code

- `apps/whispering/src/lib/tauri.tauri.ts` is the namespace.
- `apps/whispering/src/lib/tauri.browser.ts` is one line.
- `apps/whispering/vite.config.ts` for the build-time switch.
- `apps/whispering/tsconfig.json` for `moduleSuffixes`.
- Any consumer file under `apps/whispering/src/routes/` for a real call site.

Fork it, break it, ship your own version. The whole pattern is about 50 lines of code plus one Vite config line.
