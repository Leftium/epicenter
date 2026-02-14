# Slidev Runs in Your Browser via WebContainers

Go to `sli.dev/new`. In a few seconds, you're editing a Slidev presentation with live preview, hot reloading, and the full Vue component ecosystem. No CLI, no local Node.js, no install step. The entire Vite dev server boots inside your browser tab.

This works because of WebContainers, StackBlitz's technology for running Node.js inside WebAssembly. It's not a simulator or a thin client talking to a remote server. It's a real Node.js runtime with a real virtual filesystem, real npm, and real Vite. When you open that URL, the browser does roughly this:

```
Browser tab
  └── WebContainer (Node.js compiled to WASM)
       ├── Virtual filesystem
       │    ├── slides.md
       │    ├── package.json
       │    └── node_modules/
       ├── npm install (runs in-browser)
       └── Vite dev server
            └── Slidev Vue app → renders in iframe
```

The same technology powers SvelteKit's interactive tutorial at learn.svelte.dev, Angular's documentation, and Nuxt Learn. If a full SvelteKit app with server-side rendering works in a WebContainer, a Slidev presentation is well within scope.

The practical numbers: cold boot takes 2-5 seconds depending on the browser and cache state. Warm starts with cached dependencies drop to under a second. Memory usage sits around 50-100MB for the full runtime. Not lightweight, but manageable on any modern laptop.

There are real constraints. WebContainers require `SharedArrayBuffer`, which means your host page needs Cross-Origin-Isolation headers (COOP and COEP). iOS Safari support is limited. If either of those is a problem, Sandpack (CodeSandbox's alternative runtime) avoids the header requirement entirely and works on mobile Safari, though it trades off some capabilities.

What makes this interesting is the editing experience it enables. A user writes markdown in a browser-based editor, and on every keystroke Vite's HMR pipeline kicks in: the markdown gets transformed through Slidev's Vite plugins into Vue components, the Vue runtime diffs and patches the DOM, and the preview updates. Custom Vue components, Shiki code blocks, `v-click` animations, layout directives: everything works because you're running the real Slidev, not a stripped-down approximation.

For a desktop app like ours (Tauri), this architecture doesn't make much sense. We already have a real OS with a real filesystem and real Node.js. We'd just spawn `slidev dev` as a sidecar process and point a webview at it. WebContainers solve the problem of "I need a server but I don't have one," which isn't our problem.

Where it does matter is for try-before-you-install experiences and lightweight web editors. If you wanted to build a "Google Slides but with markdown" product that runs entirely client-side with no backend infrastructure, the pieces are all here: WebContainers for the runtime, Slidev for the rendering, and a collaborative editor on top. The cold boot penalty is the main UX cost, and caching makes repeat visits fast.

The Slidev team has leaned into this. Their README links directly to the StackBlitz playground, and it serves as the official "try it online" experience. There are minor rough edges (frontmatter formatting issues have been reported in the StackBlitz editor), but the core rendering works.

Running a full Vite dev server in a browser tab felt like science fiction two years ago. Now it's a link you can share in a chat message.
