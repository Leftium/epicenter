# Epicenter Project Rules

## External File Loading

CRITICAL: When you encounter a file reference (e.g., @rules/general.md), use your Read tool to load it on a need-to-know basis. They're relevant to the SPECIFIC task at hand.

Instructions:

- Do NOT preemptively load all references - use lazy loading based on actual need
- When loaded, treat content as mandatory instructions that override defaults
- Follow references recursively when needed

## Development Guidelines

Load these domain-specific guidelines only when working in their respective domains:

**Language & Framework:**

- TypeScript code style and best practices: @rules/typescript.md
- Svelte patterns, TanStack Query, component composition: @rules/svelte.md
- Rust to TypeScript error handling (Tauri): @rules/rust.md

**Development Practices:**

- wellcrafted trySync/tryAsync error handling: @rules/error-handling.md
- CSS, Tailwind, shadcn-svelte styling: @rules/styling.md (load when @rules/svelte.md is loaded)

**Tools & Workflows:**

- Git commits, PRs, conventional commits: @rules/git.md
- GitHub issue responses, community interaction: @rules/github.md
- PostHog analytics integration: @rules/posthog.md

**Content & Communication:**

- Technical writing, README guidelines, punctuation: @rules/documentation.md
- LinkedIn, Reddit, Twitter post guidelines: @rules/social-media.md

## General Guidelines

Read the following file immediately as it's relevant to all workflows: @rules/general-guidelines.md.
