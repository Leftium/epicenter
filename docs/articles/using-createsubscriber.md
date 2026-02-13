# Using `createSubscriber`

If something already knows how to notify you when it changes—`addEventListener`, `.observe()`, `.subscribe()`, `.on('change')`—then `createSubscriber` makes it reactive in Svelte with almost no code. You don't need `$state`. You don't need a shadow copy. You just need a getter that reads from the source and a bridge that tells Svelte when to re-read it.

## The Shape of the Problem

You have some external thing. It has a value. It has a way to tell you when that value changes. You want a Svelte component to re-render when it does.

```
External source        Your code           Svelte
─────────────────      ──────────────      ──────────
has a value        →   getter reads it  →  component renders it
fires change event →   ???              →  component re-renders
```

That `???` is `createSubscriber`. It fills in the missing link: "the external thing changed, Svelte should re-read my getter."

## The Recipe

Every use of `createSubscriber` follows the same three steps:

```typescript
import { createSubscriber } from 'svelte/reactivity';

// 1. Create the subscriber by telling it how to listen and how to stop
const subscribe = createSubscriber((update) => {
	source.addEventListener('change', update);
	return () => source.removeEventListener('change', update);
});

// 2. Build a getter that calls subscribe() then reads from the source
// 3. That's it. No $state needed.
```

The `update` function is a callback you receive from `createSubscriber`. Call it whenever the external source changes. Svelte will re-read any getter that called `subscribe()`.

The returned function from `start` is cleanup. It runs when no component is reading your getter anymore.

## You Don't Need `$state`

This is the most important thing to internalize. When you use `createSubscriber`, the external source is your state. You don't need to copy it into a `$state` variable and keep it in sync. You read directly from the source every time.

Svelte's own `MediaQuery` class demonstrates this:

```typescript
class MediaQuery {
	#query;
	#subscribe;

	constructor(query) {
		this.#query = window.matchMedia(query);

		this.#subscribe = createSubscriber((update) => {
			this.#query.addEventListener('change', update);
			return () => this.#query.removeEventListener('change', update);
		});
	}

	get current() {
		this.#subscribe();
		return this.#query.matches; // Read directly. No copy. No $state.
	}
}
```

`this.#query.matches` is the value. It lives on the `MediaQueryList` object, managed by the browser. The getter reads it fresh every time a component needs it. `createSubscriber` just tells Svelte when "every time" should happen: whenever the `change` event fires.

There is no `let matches = $state(false)` being kept in sync. No shadow copy that could drift. The source of truth is the source.

## When to Reach for It

The pattern fits whenever you're adopting an existing subscription API into Svelte's reactive graph. The external system already does the hard work of tracking changes and notifying listeners. You're just connecting that notification channel to Svelte's re-render cycle.

Concrete examples of things that already have their own change notification:

| External Source         | Notification Mechanism                 |
| ----------------------- | -------------------------------------- |
| `window.matchMedia`     | `change` event                         |
| `IntersectionObserver`  | callback on observe                    |
| `BroadcastChannel`      | `message` event                        |
| `EventSource` (SSE)     | `message` event                        |
| Yjs Y.Map / Y.Array     | `.observe()` callback                  |
| Firebase Realtime DB    | `.on('value')`                         |
| Svelte 4 stores         | `.subscribe()`                         |
| IndexedDB (via wrapper) | transaction callbacks                  |
| `navigator.connection`  | `change` event on `NetworkInformation` |

All of these already know when their data changes. They just don't speak Svelte. `createSubscriber` is the translator.

## Wrapping a BroadcastChannel

A `BroadcastChannel` lets browser tabs communicate. It has a `message` event. Wrapping it:

```typescript
// cross-tab-state.svelte.ts
import { createSubscriber } from 'svelte/reactivity';

export function crossTabValue<T>(channelName: string, initial: T) {
	const channel = new BroadcastChannel(channelName);
	let latest = initial;

	const subscribe = createSubscriber((update) => {
		const onMessage = (e: MessageEvent<T>) => {
			latest = e.data;
			update();
		};
		channel.addEventListener('message', onMessage);
		return () => channel.removeEventListener('message', onMessage);
	});

	return {
		get current() {
			subscribe();
			return latest;
		},
		send(value: T) {
			latest = value;
			channel.postMessage(value);
		},
	};
}
```

```svelte
<script>
	import { crossTabValue } from './cross-tab-state.svelte';
	const theme = crossTabValue('theme', 'light');
</script>

<p>Theme: {theme.current}</p>
<button onclick={() => theme.send('dark')}>Switch to dark</button>
```

Here `latest` is a plain `let`, not `$state`. It holds the most recent message. The getter reads it, `subscribe()` tells Svelte when to re-read. When another tab sends a message, the `message` event fires, `latest` updates, `update()` tells Svelte, the component re-renders.

## Wrapping an IntersectionObserver

An `IntersectionObserver` fires a callback when an element enters or leaves the viewport:

```typescript
// visible.svelte.ts
import { createSubscriber } from 'svelte/reactivity';

export function trackVisibility(element: Element) {
	let isVisible = false;

	const subscribe = createSubscriber((update) => {
		const observer = new IntersectionObserver(([entry]) => {
			isVisible = entry.isIntersecting;
			update();
		});
		observer.observe(element);
		return () => observer.disconnect();
	});

	return {
		get visible() {
			subscribe();
			return isVisible;
		},
	};
}
```

Same recipe. Plain `let` for the value, `createSubscriber` for the bridge, getter that calls `subscribe()`.

## The Getter Is Everything

The getter is where the contract lives. Three things must happen inside it, in this order:

```typescript
get value() {
  this.#subscribe();     // 1. Tell Svelte to track this read
  return this.#source;   // 2. Return the current value from the external source
}
```

If you forget `subscribe()`, Svelte reads the value once and never again. If you put `subscribe()` outside the getter (in the constructor, in a method), it runs outside a reactive context and silently does nothing—`effect_tracking()` returns `false`, so `subscribe()` becomes a no-op.

The getter runs during render, which is a reactive context. That's why it works there and nowhere else.

## When You DO Need `$state`

Sometimes the external notification doesn't carry the new value. It just says "something changed, go check." If checking is expensive, you might want to cache the result:

```typescript
export function reactiveQuery(db: Database, sql: string) {
	let cached = $state(db.execute(sql)); // expensive query, cache result

	const subscribe = createSubscriber((update) => {
		return db.onTableChange(() => {
			cached = db.execute(sql); // re-query only when notified
			update();
		});
	});

	return {
		get rows() {
			subscribe();
			return cached;
		},
	};
}
```

Here `$state` serves a different purpose: caching an expensive computation. The external source (the database) doesn't have a `.getCurrentResult()` you can call cheaply in the getter. So you compute once, store in `$state`, and re-compute only when the change notification fires.

But notice: `$state` is doing caching here, not reactivity. The `update()` call is still what tells Svelte to re-read. `$state` just ensures the re-read returns a fresh cached result rather than re-executing the query on every component render.

## Cleanup Matters

The function you return from `start` runs when the last reactive consumer disappears. If you skip it, your listener leaks:

```typescript
// Leaky: no cleanup
const subscribe = createSubscriber((update) => {
	source.addEventListener('change', update);
	// Forgot to return cleanup. Listener lives forever.
});

// Correct: cleanup returned
const subscribe = createSubscriber((update) => {
	source.addEventListener('change', update);
	return () => source.removeEventListener('change', update);
});
```

`createSubscriber` manages the lifecycle for you—`start` runs when consumers appear, cleanup runs when they disappear. But it can only call your cleanup if you provide one.

## Summary

`createSubscriber` is an adapter. You have an external system that already has a subscription mechanism. You want Svelte components to react to it. You write a getter that reads from the source, call `subscribe()` at the top, and pass `update` to the external system's change listener. No `$state` required unless you need to cache an expensive computation.

The external source is the state. `createSubscriber` is the notification channel. The getter is the read path. That's the whole thing.

## Further Reading

For a Yjs-specific example with shadow `SvelteMap` state and bidirectional mutations, see [Syncing External State with createSubscriber](./svelte-5-createsubscriber-pattern.md). For the version signal, reference counting, and `render_effect` internals, see [How createSubscriber Works](./how-createsubscriber-works.md). For choosing between `$state` and `createSubscriber` when both could work, see [`$state` vs `createSubscriber`: Who Owns the Reactivity?](./state-vs-createsubscriber-who-owns-reactivity.md).
