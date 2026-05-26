# Two files, one import: how Whispering picks a platform at build time

One of the more interesting systems in Epicenter is how Whispering picks which implementation of a service runs. The desktop version uses Rust over Tauri for the clipboard. The web version uses `navigator.clipboard`. The consumer code in `+page.svelte` doesn't know or care. Both builds get a different file behind the same import path, and the wrong one never enters the bundle.

This took us three rewrites to get right.

## The ternary version

The first version did what most Tauri apps do. We picked the implementation at runtime:

```ts
import { isTauri } from '@tauri-apps/api/core';
import { createClipboardServiceDesktop } from './desktop';
import { createClipboardServiceWeb } from './web';

export const ClipboardServiceLive = isTauri()
  ? createClipboardServiceDesktop()
  : createClipboardServiceWeb();
```

It works. It's the pattern every Tauri tutorial shows you. But it has three problems we kept stepping on.

First, both implementations ship in the web bundle. The desktop file imports `@tauri-apps/plugin-clipboard-manager`, which pulls in a few hundred KB of code that web users will never run. We're shipping dead code on purpose.

Second, the type system can't help. Nothing stops a web-only file from accidentally importing `@tauri-apps/api/core` somewhere. The build accepts it. You only find out at runtime, usually when a user reports a blank screen.

Third, every reader of the service has to re-derive what the ternary is doing. The `isTauri()` check is fine once. By the tenth service that does the same dance, you stop reading the conditional and start treating it as noise.

## What Tauri actually recommends

Tauri's docs suggest two patterns for this. Both involve some flavor of stub file.

The dynamic import version:

```ts
let filesystemService;
if (import.meta.env.VITE_TAURI_BUILD) {
  filesystemService = await import('./filesystem.tauri.js');
} else {
  filesystemService = await import('./filesystem.web.js');
}
export default filesystemService;
```

This works, but it makes every call site async. You can't statically import `ClipboardServiceLive`; you have to wait for it. The dance scatters across every consumer.

The alias version:

```ts
// vite.config.ts
resolve: {
  alias: !isTauri ? { './filesystem.tauri.js': './filesystem.web.js' } : {},
}
```

Cleaner, but you need to add an alias entry to `vite.config.ts` for every dual-impl service in the app. And Tauri's docs explicitly tell you to provide a `filesystem.web.js` even if it's "an empty module or web-compatible alternative." That's a stub file, just in a different shape.

Both patterns get you part of the way. Neither is what we ended up with.

## The pattern that stuck

We use Vite's `resolve.extensions` with a filename suffix convention. The same idea that React Native uses for `.ios.ts` and `.android.ts`, and that VS Code uses for `.browser.ts` and `.electron-sandbox.ts`. Vite supports it out of the box. No plugin, no aliases.

```ts
// vite.config.ts
const isTauri = process.env.TAURI_PLATFORM !== undefined;

export default defineConfig({
  resolve: {
    extensions: isTauri
      ? ['.tauri.ts', '.ts', '.json', '.svelte']
      : ['.browser.ts', '.ts', '.json', '.svelte'],
  },
});
```

That's the whole config. When Vite resolves an import for `$lib/services/clipboard`, it tries `.tauri.ts` first on Tauri builds and `.browser.ts` first on web builds. Whichever isn't picked is never parsed, never bundled, never type-checked against the wrong assumptions.

A clipboard service then looks like this:

```
services/clipboard/
  index.tauri.ts     ← real Tauri implementation
  index.browser.ts   ← real web implementation
  types.ts           ← shared interface both must satisfy
```

The call site doesn't change between builds:

```ts
import { ClipboardServiceLive } from '$lib/services/clipboard';

await ClipboardServiceLive.writeText('hello');
```

Synchronous. No ternary. No `isTauri()` check at the call site. The reader doesn't need to know which file got picked, because for their purposes both files do the same thing.

Inside each file, the implementation uses `satisfies` to enforce shape:

```ts
// index.browser.ts
import type { ClipboardService } from './types';

export const ClipboardServiceLive = {
  writeText: async (text) =>
    tryAsync({
      try: () => navigator.clipboard.writeText(text),
      catch: (error) => ClipboardError.WriteFailed({ cause: error }),
    }),
} satisfies ClipboardService;
```

Both files share the `ClipboardService` interface from `types.ts`. If one drifts, TypeScript complains in that file, not at the call site.

## The Tauri-only case

This is where it gets interesting. Some services have no web equivalent. The file system. The system tray. Global shortcut registration. None of these have a browser counterpart we could reasonably stub with `navigator` APIs.

The naive answer is: just don't import those services from web code. And mostly that's true. But Whispering has a few pages that exist in both builds and have a button that does something Tauri-only when clicked. The button's import path is statically reachable from web-bundled code, even though the button itself is gated by `window.__TAURI_INTERNALS__` and never fires on web.

Vite still has to resolve that import. If there's no `.browser.ts`, the web build fails.

So we keep a tiny stub file:

```ts
// services/fs/index.browser.ts
import { unreachable } from '$lib/services/_tauri-stub';
import type * as Tauri from './index.tauri';

export const FsServiceLive = {
  pathToBlob: unreachable,
  pathToFile: unreachable,
  pathsToFiles: unreachable,
} satisfies typeof Tauri.FsServiceLive;
```

`unreachable` is a single shared function:

```ts
// services/_tauri-stub.ts
export function unreachable(..._args: unknown[]): never {
  throw new Error('Tauri-only service called from web bundle');
}
```

The signature `(...args: unknown[]) => never` is the trick. `unknown` accepts any parameter shape (contravariance), `never` is assignable to any return type (bottom). So one function drops into any method slot, and `satisfies typeof Tauri.FsServiceLive` enforces that the stub has exactly the same exports as the real file.

The throw never fires in practice. The button has a runtime gate:

```svelte
<button onclick={async () => {
  if (window.__TAURI_INTERNALS__) {
    await FsServiceLive.pathToBlob(path);
  }
}}>
```

On web, the condition is false. On Tauri, the import resolved to `index.tauri.ts` instead of the stub. Either way, the throw is unreachable. The stub exists for the build, not for runtime.

## What `satisfies` buys us

The first version of these stubs used `as unknown as typeof import('./index.tauri').FsServiceLive`. That's a double cast: TypeScript stops checking anything inside it. It passes whatever you give it.

Switching to `satisfies` immediately surfaced drift the cast was hiding. The `fs` stub was missing `pathToFile` entirely. The `command` stub was missing a method that had been added to the real file weeks ago. The `permissions` stub had four error variants with stale names from before a rename.

The cost of `satisfies` over the cast is zero. The benefit is that the next time we add a method to a Tauri-only service, the web build fails until the stub is updated. The contract stays honest by itself.

## What the call sites look like in practice

After three rewrites, every service call across the app looks the same:

```ts
import { ClipboardServiceLive } from '$lib/services/clipboard';
import { TextServiceLive } from '$lib/services/text';
import { NotificationServiceLive } from '$lib/services/notifications';

await ClipboardServiceLive.writeText('hello');
await TextServiceLive.copyToClipboard(text);
await NotificationServiceLive.notify({ title: 'Done' });
```

No ternary. No dynamic import. No platform check. The reader sees a function call and reads it as a function call.

The two builds produce different bundles. The web bundle has no Tauri code in it; we verified this by grepping the production build for `@tauri-apps` and getting zero hits. The Tauri bundle has no `navigator.clipboard` fallbacks. Each build ships only what it needs.

## When this isn't the answer

Build-time DI doesn't fit every "which implementation" decision. Some choices the user makes at runtime, and you can't push those to the build.

Transcription provider is the obvious one. The user picks OpenAI or Groq in settings. Both implementations have to be in the bundle, because the user can switch mid-session. That's runtime DI, and it stays runtime. We have a separate article on that: `20260526T030000-bind-platform-once-bind-settings-every-time.md`.

The clean test: can the answer change between now and the next call? If yes, runtime. If the answer is fixed once you know "Tauri or web," build-time.

## If you want to copy this

The whole pattern is about 60 lines of Vite config plus filename discipline. The hardest part isn't the mechanism; it's deciding which services to split and which to leave alone. Our rule of thumb: split if both platforms have a real implementation. Stub if only one does and the import path is reachable from shared code.

If you want to see the actual code, the relevant files are:

- `apps/whispering/vite.config.ts` for the `resolve.extensions` switch.
- `apps/whispering/src/lib/services/_tauri-stub.ts` for the shared `unreachable`.
- Any service folder under `apps/whispering/src/lib/services/` for a concrete example.

Fork it, break it, ship your own version. The setup is small enough that you can read the whole thing in five minutes.
