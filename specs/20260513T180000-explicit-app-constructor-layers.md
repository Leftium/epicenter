# Explicit App Constructor Layers

Status: Implemented
Date: 2026-05-13

Each app constructor names the runtime layer it builds, and every runtime layer composes the same pure document constructor.

## Naming Table

| App | Document | Browser | Script | Daemon |
| --- | --- | --- | --- | --- |
| Fuji | `openFujiDocument`, `FujiDocument` | `openFujiBrowser`, `FujiBrowser` | `openFujiScript`, `FujiScript` | `defineFujiDaemon` |
| Honeycrisp | `openHoneycrispDocument`, `HoneycrispDocument` | `openHoneycrispBrowser`, `HoneycrispBrowser` | `openHoneycrispScript`, `HoneycrispScript` | `defineHoneycrispDaemon` |
| Opensidian | `openOpensidianDocument`, `OpensidianDocument` | `openOpensidianBrowser`, `OpensidianBrowser` | `openOpensidianScript`, `OpensidianScript` | `defineOpensidianDaemon` |
| Zhongwen | `openZhongwenDocument`, `ZhongwenDocument` | `openZhongwenBrowser`, `ZhongwenBrowser` | `openZhongwenScript`, `ZhongwenScript` | `defineZhongwenDaemon` |
| Tab Manager | `openTabManagerDocument`, `TabManagerDocument` | `openTabManagerBrowser`, `TabManagerBrowser` | none | none |

Tab Manager uses `Browser` because the constructor composes the same browser runtime resources as the web apps: IndexedDB, owned broadcast channel, collaboration, and wipe. The file is still named `extension.ts` because the surrounding app is a Chrome extension.

## Checklist

- [x] Move document factories from `index.ts` to `document.ts`.
- [x] Rename document factories from `openXDoc` to `openXDocument`.
- [x] Rename browser factories from `openX` to `openXBrowser`.
- [x] Rename ambiguous script factories from `openX` to `openXScript`.
- [x] Keep `defineXDaemon` names because they return route definitions.
- [x] Export derived `XDocument`, `XBrowser`, and `XScript` types beside their constructors.
- [x] Replace stale `./openX` package subpaths with `./document`.
- [x] Keep `./browser`, `./daemon`, and `./script` subpaths where those layers exist.
- [x] Avoid compatibility aliases for old names.
