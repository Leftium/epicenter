<script lang="ts">
	import { Marp } from '@marp-team/marp-core';

	const SAMPLE_MARKDOWN = `
---
theme: default
---

# Slide 1: Hello Marp!

This is a test of **marp-core** running in the browser.

---

# Slide 2: Features

- Bullet points work
- **Bold** and *italic*
- Code: \`console.log('hello')\`

---

# Slide 3: Code Block

\`\`\`javascript
function greet(name) {
  return \`Hello, \${name}!\`;
}
\`\`\`
`.trim();

	let rendered = $state<{ html: string; css: string } | null>(null);
	let error = $state<string | null>(null);
	let renderTimeMs = $state<number | null>(null);
	let slideContainer = $state<HTMLDivElement | null>(null);

	function handleRender() {
		error = null;
		rendered = null;
		renderTimeMs = null;

		try {
			const start = performance.now();
			const marp = new Marp({
				script: false,
				math: false,
			});
			const result = marp.render(SAMPLE_MARKDOWN);
			renderTimeMs = Math.round(performance.now() - start);
			rendered = result;
			console.log('Marp render result:', result);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			console.error('Marp render failed:', e);
		}
	}

	$effect(() => {
		if (!slideContainer || !rendered) return;

		if (!slideContainer.shadowRoot) {
			slideContainer.attachShadow({ mode: 'open' });
		}
		const root = slideContainer.shadowRoot!;
		root.innerHTML =
			rendered.html +
			`<style>${rendered.css}</style>` +
			`<style>:host { all: initial; display: block; }</style>`;
	});
</script>

<main style="max-width: 900px; margin: 2rem auto; font-family: sans-serif;">
	<h1>Marp Browser Test</h1>

	<button
		onclick={handleRender}
		style="padding: 0.5rem 1.5rem; font-size: 1rem; cursor: pointer;"
	>
		Render with Marp
	</button>

	{#if error}
		<pre
			style="color: red; margin-top: 1rem; padding: 1rem; background: #fee; border-radius: 4px;">{error}</pre>
	{/if}

	{#if rendered}
		<p style="margin-top: 1rem; color: green;">
			Rendered in {renderTimeMs}ms — html length: {rendered.html.length}, css
			length: {rendered.css.length}
		</p>

		<h2>Rendered Slides (Shadow DOM)</h2>
		<div
			bind:this={slideContainer}
			style="border: 2px solid #ccc; border-radius: 8px; overflow: hidden; margin-top: 0.5rem;"
		></div>

		<details style="margin-top: 1rem;">
			<summary>Raw HTML</summary>
			<pre
				style="max-height: 300px; overflow: auto; background: #f5f5f5; padding: 1rem; font-size: 0.75rem;">{rendered.html}</pre>
		</details>

		<details>
			<summary>Raw CSS</summary>
			<pre
				style="max-height: 300px; overflow: auto; background: #f5f5f5; padding: 1rem; font-size: 0.75rem;">{rendered.css}</pre>
		</details>
	{/if}
</main>
