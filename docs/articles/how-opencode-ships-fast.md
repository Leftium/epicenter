# How OpenCode Ships Fast: Lessons from 618 Releases

OpenCode hit v1.0.191 in late December 2025. That's 618 releases total, with 30 of them happening in just 11 days. Some days saw 6 releases. This isn't accidental; it's the result of deliberate engineering choices that make releasing trivially cheap.

Here's what they do differently.

---

## 1. Custom Release Automation (Not Off-the-Shelf Tools)

Most projects use Changesets, Release Please, or semantic-release. OpenCode built their own TypeScript script that does exactly what they need, nothing more.

Their `publish-start.ts` script handles everything:

```typescript
#!/usr/bin/env bun
import { $ } from 'bun';
import { createOpencode } from '@opencode-ai/sdk';

// Bump version across all packages
for (const file of pkgjsons) {
	let pkg = await Bun.file(file).text();
	pkg = pkg.replaceAll(/"version": "[^"]+"/g, `"version": "${newVersion}"`);
	await Bun.file(file).write(pkg);
}

// Create git tag and push
await $`git add -A`;
await $`git commit -m "release: v${version}"`;
await $`git tag v${version}`;
await $`git push origin HEAD --tags`;
```

The advantage: no configuration files, no tool-specific conventions, no waiting for upstream fixes. When something doesn't work, they change their own script.

---

## 2. AI-Generated Changelogs

Writing changelogs is tedious. OpenCode eliminated this entirely by having AI analyze commits and generate release notes automatically.

```typescript
const opencode = await createOpencode();
const session = await opencode.client.session.create();

const changelog = await opencode.client.session.prompt({
	model: { providerID: 'opencode', modelID: 'gemini-3-flash' },
	parts: [
		{
			type: 'text',
			text: `Analyze these commits and generate a changelog:
    ${commits.map((c) => c.message).join('\n')}`,
		},
	],
});
```

The changelog gets included in the GitHub release automatically. No human writes release notes.

---

## 3. Continuous Deployment on Every Merge

Their GitHub Actions workflow triggers on every push to `dev`:

```yaml
name: publish
on:
  push:
    branches:
      - dev
```

This means every merged PR can become a release within minutes. There's no "release day" or batching. A bug fix merged at 2pm ships at 2:05pm.

The workflow also supports manual dispatch with version control:

```yaml
workflow_dispatch:
  inputs:
    bump:
      description: 'Version bump type'
      type: choice
      options: [patch, minor, major]
```

---

## 4. Unified Versioning Across the Monorepo

OpenCode uses a monorepo with multiple packages:

```
packages/
  opencode/          # CLI
  opencode-ai/       # npm package
  console/           # Web UI
  sdk/js/            # JavaScript SDK
  desktop/           # Electron app
```

All packages share the same version number. When they release v1.0.191, every package becomes v1.0.191. This eliminates coordination overhead; there's no "which packages need a release?" question.

The script updates all `package.json` files in one pass:

```typescript
const pkgjsons = await glob('packages/**/package.json');
for (const file of pkgjsons) {
	let pkg = await Bun.file(file).text();
	pkg = pkg.replaceAll(/"version": "[^"]+"/g, `"version": "${version}"`);
	await Bun.file(file).write(pkg);
}
```

---

## 5. Patch-Only Release Strategy

OpenCode stays on v1.0.x indefinitely. Every release increments the patch version:

```
v1.0.188 → v1.0.189 → v1.0.190 → v1.0.191
```

This removes decision-making overhead. Nobody debates whether a change is "minor" or "patch." Everything is patch. The version number becomes a simple release counter.

The implicit contract: v1.0.x is stable enough for production, but expect frequent updates. Users who want stability can pin to a specific version.

---

## 6. Parallel Multi-Platform Builds

OpenCode ships desktop apps for 5 platforms:

| Platform              | Asset                                 |
| --------------------- | ------------------------------------- |
| macOS (Apple Silicon) | `opencode-desktop-darwin-aarch64.dmg` |
| macOS (Intel)         | `opencode-desktop-darwin-x64.dmg`     |
| Windows               | `opencode-desktop-windows-x64.exe`    |
| Linux (x64)           | `.deb`, `.rpm`, AppImage              |
| Linux (ARM)           | `.deb`, `.rpm`, AppImage              |

All builds run in parallel using GitHub Actions matrix:

```yaml
strategy:
  matrix:
    include:
      - os: macos-latest
        target: darwin-aarch64
      - os: macos-latest
        target: darwin-x64
      - os: ubuntu-latest
        target: linux-x64
      - os: ubuntu-latest
        target: linux-arm64
      - os: windows-latest
        target: windows-x64
```

A release that would take 45 minutes sequentially finishes in under 10 minutes.

---

## 7. Fast Tooling

OpenCode uses Bun instead of Node.js throughout their toolchain:

```json
{
	"packageManager": "bun@1.3.5"
}
```

Bun's faster startup time and native TypeScript execution mean their release scripts run in seconds, not minutes.

They also use Turborepo for monorepo task orchestration:

```json
{
	"scripts": {
		"build": "bun turbo build",
		"typecheck": "bun turbo typecheck"
	}
}
```

Turbo caches builds aggressively; if a package hasn't changed, it doesn't rebuild.

For CI, they use custom Blacksmith runners instead of default GitHub-hosted runners:

```yaml
runs-on: blacksmith-4vcpu-ubuntu-2404
```

These runners have more CPU cores and faster disk I/O, reducing build times further.

---

## 8. Automatic Code Generation

A separate workflow runs before releases to generate code:

```yaml
name: generate
on:
  push:
    branches:
      - dev

jobs:
  generate:
    steps:
      - run: ./script/generate.ts
      - run: |
          git add -A
          git commit -m "chore: generate"
          git push origin HEAD --no-verify
```

This handles things like TypeScript type generation, API client generation, and schema updates. The generated code gets committed automatically, so the release workflow always has up-to-date artifacts.

---

## 9. Draft Releases with Binary Uploads

The release script creates GitHub releases in draft mode:

```typescript
await $`gh release create v${version} \
  --draft \
  --title "v${version}" \
  --notes "${changelog}"`;

// Upload binaries
for (const binary of binaries) {
	await $`gh release upload v${version} ${binary}`;
}
```

This gives maintainers a chance to review the release before it goes public. But the review is optional; if everything looks good, they just click "Publish."

---

## 10. Minimal Manual Intervention

The complete release flow:

1. Developer merges PR to `dev`
2. `generate.yml` runs automatically, commits generated code
3. `publish.yml` triggers on the new commit
4. Script bumps versions in all `package.json` files
5. AI generates changelog from commits
6. All packages build in parallel
7. Desktop apps build for 5 platforms in parallel
8. Git tag created and pushed
9. GitHub draft release created with binaries attached
10. Human clicks "Publish" (optional review)

Steps 2-9 happen without human intervention. The entire process takes about 10 minutes from merge to published release.

---

## The Core Insight

OpenCode treats releases as a continuous, automated process rather than a manual event. They've systematically removed every source of friction:

| Friction Point                  | Their Solution                   |
| ------------------------------- | -------------------------------- |
| Writing changelogs              | AI generates them                |
| Deciding version numbers        | Always patch                     |
| Coordinating package versions   | All packages share one version   |
| Building for multiple platforms | Parallel matrix builds           |
| Slow CI                         | Bun + Turbo + custom runners     |
| Manual git operations           | Fully scripted                   |
| Release approval                | Draft releases (optional review) |

The result: releasing becomes so cheap that there's no reason to batch changes. A single bug fix can ship immediately. A new feature doesn't wait for the next "release window."

---

## Applying This to Your Project

Not every project needs 6 releases per day. But the principles scale down:

1. **Automate changelog generation**: Even simple commit-based changelogs beat manual writing
2. **Trigger releases automatically**: On merge to main, on tag push, whatever fits your workflow
3. **Simplify versioning**: If you're not publishing a library with semver guarantees, consider patch-only
4. **Parallelize builds**: Matrix strategies are free in GitHub Actions
5. **Use fast tools**: Bun, pnpm, Turbo, esbuild; modern tools are significantly faster
6. **Script everything**: If you do it manually more than twice, automate it

The goal isn't shipping fast for its own sake. It's making releases cheap enough that shipping becomes a non-decision. When releasing takes 2 minutes of human time, you ship when the code is ready, not when you've accumulated enough changes to justify the overhead.

---

## References

- [OpenCode GitHub Repository](https://github.com/sst/opencode)
- [OpenCode Release History](https://github.com/sst/opencode/releases)
- [publish.yml Workflow](https://github.com/sst/opencode/blob/dev/.github/workflows/publish.yml)
- [publish-start.ts Script](https://github.com/sst/opencode/blob/dev/script/publish-start.ts)
