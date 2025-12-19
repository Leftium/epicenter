# Rust Learning Plan for Whispering Development

Based on analysis of the Whispering codebase, here's a **prioritized** learning plan tailored for someone with strong JS/TS experience.

---

## Priority 1: Essential (Learn First)

These are **required** to make meaningful contributions:

### 1. Ownership & Borrowing Basics

- **Why**: Used everywhere - function parameters, state access
- **Focus**: `&self`, `&mut self`, `&str` vs `String`, when to use `.clone()`
- **Skip**: Complex lifetime annotations (rare in this codebase)

```rust
// You'll see patterns like this constantly:
pub fn enumerate_devices(&self) -> Result<Vec<String>>  // Immutable borrow
pub fn start_recording(&mut self) -> Result<()>         // Mutable borrow
```

### 2. Result and Option Types

- **Why**: Every Tauri command returns `Result<T, E>`
- **Focus**: `?` operator, `.map_err()`, `.ok()`, `.unwrap_or_else()`
- **JS Parallel**: Like `Promise`, but for sync error handling

```rust
// You'll write these patterns constantly:
let data = some_operation().map_err(|e| e.to_string())?;
```

### 3. Structs + Derive Macros

- **Why**: All data types use derives for Tauri IPC
- **Focus**: `#[derive(Debug, Clone, Serialize, Deserialize)]`, serde attributes
- **JS Parallel**: Like TypeScript interfaces, but with attached behavior

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]  // Matches TS conventions!
pub struct AudioRecording {
    pub blob: Vec<u8>,
    pub duration_ms: u64,
}
```

### 4. Enums (Tagged Unions)

- **Why**: Error types use tagged enums for TS discriminated unions
- **Focus**: Variant definitions, `match` expressions, serde `#[serde(tag = "name")]`
- **JS Parallel**: Like TypeScript discriminated unions

```rust
#[derive(Error, Debug, Serialize)]
#[serde(tag = "name")]  // Creates { name: "GpuError", message: "..." }
pub enum TranscriptionError {
    #[error("GPU error: {message}")]
    GpuError { message: String },
}
```

### 5. Tauri Command Pattern

- **Why**: The primary interface between Rust and TypeScript
- **Focus**: `#[tauri::command]`, `State<'_, T>`, async commands

```rust
#[tauri::command]
pub async fn my_command(
    param: String,
    state: State<'_, AppData>,  // Don't worry about the lifetime here
) -> Result<ReturnType, String> {
    // Your logic
}
```

---

## Priority 2: Important (Learn Second)

Needed for **modifying core functionality**:

### 6. Mutex and Arc

- **Why**: Shared state across threads (recording, model manager)
- **Focus**: `Arc<Mutex<T>>`, `.lock()`, `.unwrap_or_else()` for poison recovery
- **JS Parallel**: Like shared state, but explicit locking

```rust
// This pattern is everywhere:
let mut guard = state.recorder.lock().map_err(|e| e.to_string())?;
guard.start_recording()
```

### 7. Async/Await Basics

- **Why**: All Tauri commands are async
- **Focus**: `async fn`, `.await`, `tokio::task::spawn_blocking`
- **JS Parallel**: Almost identical syntax!

```rust
// Wrap blocking operations for async:
tokio::task::spawn_blocking(move || {
    // CPU-intensive work here
}).await
```

### 8. Pattern Matching

- **Why**: Used extensively for enum handling, error recovery
- **Focus**: `match`, `if let`, destructuring

```rust
match sample_format {
    SampleFormat::F32 => process_f32(data),
    SampleFormat::I16 => process_i16(data),
    _ => return Err("Unsupported format"),
}
```

---

## Priority 3: Helpful (Learn as Needed)

For **advanced modifications**:

### 9. Channels (mpsc)

- **Why**: Used in audio recording thread communication
- **When**: Only if modifying recorder internals

### 10. Conditional Compilation

- **Why**: Platform-specific code paths
- **Focus**: `#[cfg(target_os = "macos")]`, `#[cfg(windows)]`

### 11. Traits

- **Why**: Understanding library APIs
- **Focus**: `impl Trait for Type`, common traits like `Drop`, `Clone`

---

## Can Safely Ignore/Deemphasize

These are **not used** or **rarely needed** in Whispering:

| Topic                         | Why Skip                                                     |
| ----------------------------- | ------------------------------------------------------------ |
| **Explicit Lifetimes**        | Only one instance in codebase (`State<'_, T>` is copy-paste) |
| **Unsafe Rust**               | Not used                                                     |
| **Macros (writing)**          | Uses derive macros, doesn't write them                       |
| **Generic Programming**       | Minimal - mostly concrete types                              |
| **Closures (advanced)**       | Basic closures only                                          |
| **Smart Pointers beyond Arc** | No `Rc`, `RefCell`, `Box<dyn>` patterns                      |
| **Iterators (advanced)**      | Basic `.iter()`, `.map()`, `.filter()` suffice               |
| **Module system (advanced)**  | Simple flat structure                                        |

---

## Recommended Learning Path

### Week 1-2: Foundations

1. [Rust Book](https://doc.rust-lang.org/book/) Chapters 3-6 (basics, ownership, structs, enums)
2. Practice: Read `recorder/commands.rs` - simple Tauri command wrappers

### Week 2-3: Error Handling & Tauri

1. Rust Book Chapter 9 (Error Handling)
2. [Tauri v2 Commands Docs](https://tauri.app/develop/calling-rust/)
3. Practice: Add a simple new command

### Week 3-4: Concurrency

1. Rust Book Chapter 16 (Concurrency) - focus on `Arc<Mutex<T>>`
2. Practice: Read `transcription/model_manager.rs`

### Ongoing: Reference as Needed

- [Serde docs](https://serde.rs/) for serialization questions
- [Tokio docs](https://tokio.rs/) for async patterns

---

## Quick Reference: JS/TS to Rust Translations

| TypeScript                      | Rust                             |
| ------------------------------- | -------------------------------- |
| `interface Foo { bar: string }` | `struct Foo { bar: String }`     |
| `type \| null`                  | `Option<T>`                      |
| `Promise<T>` (can fail)         | `Result<T, E>`                   |
| `try/catch`                     | `?` operator + `Result`          |
| `async/await`                   | `async`/`.await` (same!)         |
| `foo?.bar`                      | `foo.as_ref().map(\|f\| &f.bar)` |
| `const x = obj as Type`         | `let x: Type = ...`              |
| `Record<string, T>`             | `HashMap<String, T>`             |
| `Array<T>`                      | `Vec<T>`                         |

---

## First Practical Exercise

After learning basics, try this exercise in the Whispering codebase:

1. **Read** `apps/whispering/src-tauri/src/transcription/error.rs`
2. **Trace** how errors flow from Rust to TypeScript
3. **Add** a new error variant and handle it in TypeScript

This touches ownership, enums, serde, and Tauri commands - all the essentials.
