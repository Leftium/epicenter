# Why Custom prose.css Instead of @tailwindcss/typography

## Why we don't use @tailwindcss/typography at all in Epicenter

In Epicenter, we use a custom `prose.css` instead of the official `@tailwindcss/typography` plugin. The reason is better [ShadCN integration](http://localhost:5174/docs/components/typography) and dark mode support.

## The Problem

`@tailwindcss/typography` uses its own CSS variables (`--tw-prose-body`, `--tw-prose-headings`) that don't integrate with shadcn's semantic tokens. Dark mode requires adding `dark:prose-invert` to every prose element.

## Our Approach

We wrote `packages/ui/src/prose.css` using shadcn's color tokens directly:

```css
.prose {
  @apply max-w-[65ch] text-foreground;

  & a {
    @apply font-medium text-primary underline underline-offset-4;
  }

  & pre {
    @apply bg-muted text-foreground rounded-md p-4;
  }
}
```

Dark mode works automatically because `text-foreground` and `bg-muted` adapt based on the `.dark` class.

## Adding Size Variants

The trade-off: we add variants manually. For compact contexts like dialogs:

```css
.prose-sm {
  @apply text-sm leading-normal;
  & h1 { @apply text-xl mt-4 first:mt-0; }
  & h2 { @apply text-lg mt-4 first:mt-0; }
  & p { @apply mt-2; }
}
```

## Usage

```svelte
<div class="prose prose-sm">
  {@html renderMarkdown(content)}
</div>
```

## Comparison

| Approach | Dark Mode | Size Variants | Design System |
|----------|-----------|---------------|---------------|
| @tailwindcss/typography | Manual (`dark:prose-invert`) | Built-in | Separate |
| Custom prose.css | Automatic | Manual | Integrated with shadcn |

We trade built-in variants for seamless shadcn integration.
