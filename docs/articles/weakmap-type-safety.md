# How WeakMaps Fixed My Type Safety Problem (And Can Fix Yours)

I was building a WebSocket sync feature and hit a frustrating TypeScript problem. I had connection objects I didn't control, and I needed to attach data to them. Every time I accessed that data, TypeScript made me cast types with `as`.

Cast here. Cast there. Cast everywhere. Each one a potential runtime bomb.

Then I discovered WeakMap, and all those casts disappeared. Let me show you how.

## The Problem: Trust Me Bro™ Type Safety

Here's what I was doing:

```typescript
// Storing data on a WebSocket connection
const wsData = ws.data as Record<string, unknown>;
wsData.room = room;
wsData.doc = doc;

// Later, reading it back
const wsData = ws.data as Record<string, unknown>;  // Cast #1
const room = wsData.room as string;                 // Cast #2
const doc = wsData.doc as Y.Doc;                    // Cast #3
```

See those `as` keywords? Each one is me promising TypeScript: "Trust me, this is the right type."

But what if `room` is actually undefined? What if someone typo'd it as `romm`? TypeScript has no idea. It blindly trusts every cast. I've just turned TypeScript into JavaScript with extra steps.

## What's a WeakMap?

Think of a parking garage. You drive your car in, they give you a ticket. Later, you show the ticket, they return your car.

WeakMap is that garage:
- Your object (the WebSocket) is the car
- The data you want to attach is the ticket
- When you need the data, you show the object and get it back

But here's the clever part: when your car drives away for good (object gets garbage collected), the parking garage automatically removes that ticket. No manual cleanup. No memory leaks.

```typescript
// Create the "garage"
const connectionState = new WeakMap<object, YourDataType>();

// Park the "car" with its "ticket"
connectionState.set(ws, { room, doc, awareness });

// Retrieve the "ticket" by showing the "car"
const state = connectionState.get(ws);
```

That's it. Map an object to some data. Get it back later. Automatic cleanup.

## The Type Safety Win

Here's where it gets good. With WeakMap, you define your data shape ONCE:

```typescript
type ConnectionState = {
  room: string;
  doc: Y.Doc;
  awareness: Awareness;
  updateHandler: (update: Uint8Array) => void;
};

const connectionState = new WeakMap<object, ConnectionState>();
```

Now every time you set or get data, TypeScript enforces that exact shape. No casts needed:

```typescript
// Storing - TypeScript checks you're providing the right shape
connectionState.set(ws, { room, doc, awareness, updateHandler });

// Reading - TypeScript KNOWS all the types
const state = connectionState.get(ws);
if (!state) return;  // Handle the "not found" case

// Zero casts. Full type safety.
const { room, doc, awareness } = state;
```

Notice what happened there? No `as` keywords. No trust-me-bro promises. TypeScript actually knows what types these things are.

If you typo a property name, you get an error at compile time, not a crash at 3am.

## Why "Weak"?

The "weak" part means the Map doesn't prevent garbage collection.

With a regular Map, if you store an object as a key, JavaScript keeps that object alive forever (or until you manually delete it). That's a memory leak waiting to happen.

With WeakMap, when nothing else references your object, JavaScript can clean it up. The WeakMap entry disappears automatically.

This is perfect for attaching metadata to objects you don't control. When the WebSocket closes and gets cleaned up, all my attached data disappears too. No manual cleanup code. No leaks.

## When Should You Use This?

WeakMap shines when:

1. **You need to attach data to objects you don't control** (like framework objects, DOM nodes, WebSockets)
2. **You're tired of type assertions** and want actual type safety
3. **You want automatic cleanup** when objects go away

I use WeakMap for:
- Storing per-connection state in WebSocket servers
- Attaching metadata to DOM elements
- Caching computed values based on objects

Don't use WeakMap for:
- String keys (use regular Map or objects)
- Primitive keys like numbers (use regular Map)
- When you need to iterate over entries (WeakMap isn't iterable)

## The Refactor

In my WebSocket code, this change eliminated 10+ type assertions. Every single `ws.data as Record<string, unknown>` disappeared. Every `room as string` vanished.

More importantly, I caught bugs during the refactor where I'd been casting to the wrong type. TypeScript had been trusting me. Turns out I wasn't trustworthy.

WeakMap made the type system work for me instead of me working around it.

If you're casting types repeatedly for the same pattern, you might need a WeakMap. Your future self (and your production error logs) will thank you.
