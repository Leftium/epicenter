# Y.Doc Size Benchmark

Interactive tool to test single Y.Doc size limits. Useful for understanding when a single-document architecture becomes problematic and validating the multi-doc approach in the [subdoc architecture spec](../../docs/specs/20260122T225052-subdoc-architecture.md).

## Quick Start

```bash
cd examples/yjs-size-benchmark
bun install
bun dev
```

Opens at http://localhost:5177. Access from your phone using the network URL shown in the app (must be on same WiFi).

## What It Tests

- **Doc Size**: Binary size of the Y.Doc after encoding
- **Memory Usage**: JS heap consumption (Chrome only)
- **Write Speed**: Rows inserted per second
- **Encode/Decode Time**: Serialization performance
- **Bytes/Row**: Storage efficiency
- **3G Load Estimate**: How long initial sync would take on slow mobile

## Presets

| Preset | Config               | Total Rows | Expected Size |
| ------ | -------------------- | ---------- | ------------- |
| Small  | 1 table × 1k rows    | 1,000      | ~0.8 MB       |
| Medium | 5 tables × 5k rows   | 25,000     | ~20 MB        |
| Large  | 20 tables × 10k rows | 200,000    | ~160 MB       |
| Huge   | 50 tables × 20k rows | 1,000,000  | ~800 MB       |

## Key Findings

From testing, each row with 10 fields × 50 chars ≈ **860 bytes** in YJS (18% overhead vs raw JSON).

The "Large" preset matches the spec's example workspace (20 tables × 1k rows each). At ~16 MB, this would take **6 minutes to sync on 3G** — the main motivation for the multi-doc architecture.

## Download .yjs File

Click "Download .yjs" to save the generated document. You can then test loading it on different devices to measure cold-start parse times.
