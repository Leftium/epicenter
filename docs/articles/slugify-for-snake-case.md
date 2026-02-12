# Using slugify for snake_case

Most people know [`@sindresorhus/slugify`](https://github.com/sindresorhus/slugify) for generating URL slugs. But here's a trick: it's actually a flexible string normalizer that can generate snake_case, camelCase alternatives, or even concatenated strings.

## The Trick

The `separator` option controls what goes between words:

```typescript
import slugify from '@sindresorhus/slugify';

// Default: kebab-case (URL slugs)
slugify('BAR and baz');
//=> 'bar-and-baz'

// snake_case
slugify('BAR and baz', { separator: '_' });
//=> 'bar_and_baz'

// No separator
slugify('BAR and baz', { separator: '' });
//=> 'barandbaz'
```

We wrapped this pattern into a shared utility called `snakify`:

```typescript
import slugify from '@sindresorhus/slugify';

/** Convert any string to snake_case using slugify. */
export function snakify(str: string): string {
	return slugify(str, { separator: '_' });
}
```

## Real Use Case: SQL Column Names

I needed to convert display names to SQL-safe column identifiers. Rolling your own regex is tempting but fragile:

```typescript
// Fragile DIY approach
function toSnakeCase(str: string): string {
	return str
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, '')
		.replace(/\s+/g, '_');
}
```

This breaks on unicode, doesn't handle edge cases, and you'll be patching it forever.

With slugify:

```typescript
import slugify from '@sindresorhus/slugify';

function toSqlIdentifier(displayName: string): string {
	return slugify(displayName, { separator: '_' }); // or return snakify(displayName);
}

toSqlIdentifier('Blog Posts'); // => 'blog_posts'
toSqlIdentifier('Created At'); // => 'created_at'
toSqlIdentifier('Author'); // => 'author'
toSqlIdentifier("What's This?"); // => 'whats_this'
toSqlIdentifier('Foo & Bar'); // => 'foo_and_bar'
```

It handles the edge cases you didn't think of.

## Why Not Roll Your Own

Slugify has:

- Proper unicode handling (transliteration)
- Configurable replacements (`&` → `and`)
- Millions of weekly downloads (battle-tested)
- Consistent, predictable behavior

Your regex will work until it doesn't.

## Related: filenamify

Same author, same philosophy: [`@sindresorhus/filenamify`](https://github.com/sindresorhus/filenamify).

```typescript
import filenamify from 'filenamify';

filenamify('<foo/bar>');
//=> 'foobar'

filenamify('foo:"bar"', { replacement: '-' });
//=> 'foo-bar'
```

Takes messy input, produces filesystem-safe output. No thinking required.

## Links

- [slugify](https://github.com/sindresorhus/slugify) - Make a string URL-safe (or snake_case, or whatever)
- [filenamify](https://github.com/sindresorhus/filenamify) - Make a string safe for filenames
- [sindresorhus](https://github.com/sindresorhus) - The author behind 1000+ npm packages
