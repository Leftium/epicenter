# PRs Are Searchable Artifacts

We recently needed to prove that `@marp-team/marp-core` could render slide presentations entirely in the browser, with no server and no headless browser. The result was a throwaway Svelte app that will never see production.

We made it a PR anyway: [#1352](https://github.com/EpicenterHQ/epicenter/pull/1352).

Even after you delete the app, the PR stays as a searchable artifact with the context, screenshots, and findings. Way better than a commit buried in `git log`.

The PR description captured everything that matters: what we tested, how fast it rendered (23ms), what flags were needed (`math: false` to avoid a 2MB mathjax-full bundle), and why the alternative (Slidev) couldn't work. When we build the real slideshow feature months from now, that PR is the starting point. Search "marp" in GitHub, find it instantly.

Even for throwaway experiments, PRs are a great way to have that searchable artifact.
