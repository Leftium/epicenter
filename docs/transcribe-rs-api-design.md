# transcribe-rs API Design (B++ with Channels)

## Overview

A simple, event-driven API that hides internal complexity while handling backpressure and error propagation.

## Consumer Code (No Loops!)

```rust
// Setup
let transcriber = transcribe_rs::Engine::new(config)?;

// Start - callback returns Result for error propagation
transcriber.start_listening(|result| {
    match result {
        Ok(Partial(text)) => app.emit("partial", text)?,
        Ok(Final(text)) => app.emit("final", text)?,
        Err(e) => app.emit("error", e.to_string())?,
    }
    Ok(())  // or Err(e) to stop listening
})?;

// Feed audio - called from Tauri's audio capture thread
transcriber.push_audio(&samples);

// Stop when done
transcriber.stop_listening()?;
```

## What's Hidden Inside transcribe-rs

```rust
// transcribe_rs/src/engine.rs

impl Engine {
    pub fn start_listening<F>(&self, callback: F)
    where
        F: Fn(Result<TranscriptionResult, Error>) -> Result<(), Error>
    {
        let (audio_tx, audio_rx) = channel();
        let (result_tx, result_rx) = channel();

        // INTERNAL THREAD 1: Decode thread
        thread::spawn(move || {
            loop {
                let samples = match audio_rx.recv() {
                    Ok(s) => s,
                    Err(_) => break,  // channel closed
                };

                stream.accept_waveform(&samples);
                while stream.is_ready() {
                    stream.decode();
                }

                let result = stream.get_result();
                if result_tx.send(Ok(result)).is_err() {
                    break;  // channel closed
                }
            }
        });

        // INTERNAL THREAD 2: Callback thread
        thread::spawn(move || {
            loop {
                let result = match result_rx.recv() {
                    Ok(r) => r,
                    Err(_) => break,  // channel closed
                };

                // Callback returns Result - errors stop the loop
                if let Err(e) = callback(result) {
                    log::error!("Callback error, stopping: {}", e);
                    break;
                }
            }
        });
    }

    pub fn push_audio(&self, samples: &[f32]) {
        let _ = self.audio_tx.send(samples);
    }
}
```

## Thread Model

```
TAURI AUDIO THREAD              transcribe-rs INTERNAL THREADS

┌──────────────────┐           ┌──────────────────┐    ┌──────────────────┐
│ cpal callback    │           │ Decode Thread    │    │ Callback Thread  │
│                  │           │                  │    │                  │
│ transcriber      │   chan    │ loop {           │chan│ loop {           │
│  .push_audio() ─────────────▶│   decode()      ─────▶│   callback()    │
│                  │           │ }                │    │   if Err → stop │
└──────────────────┘           └──────────────────┘    └──────────────────┘
                                                              │
                                                              ▼
                                                        app.emit()
                                                        (to SvelteKit)
```

## Error Flow

| Error Source           | How It's Handled                   |
| ---------------------- | ---------------------------------- |
| Decode fails           | Sent as `Err(e)` to callback       |
| `app.emit()` fails     | Callback returns `Err`, loop stops |
| Channel closed         | Threads exit gracefully            |
| Consumer wants to stop | Return `Err` from callback         |

## Summary

| Concern           | Solution                                    |
| ----------------- | ------------------------------------------- |
| Backpressure      | Channels buffer between threads             |
| Error propagation | Callback returns `Result<(), Error>`        |
| Graceful shutdown | Errors or `stop_listening()` close channels |

**Three threads, two channels, full error handling, zero loops in consumer code.**

## Architecture Layers

```
┌─────────────────────────────────────────────────────────────┐
│ 3rd Party APIs (sherpa-onnx, ElevenLabs, etc.)             │
│                                                             │
│ sherpa: push audio → pull results (is_ready/decode loop)   │
└─────────────────────────┬───────────────────────────────────┘
                          │ wrap with channel (internal pull)
                          ▼
┌─────────────────────────────────────────────────────────────┐
│ transcribe-rs                                               │
│                                                             │
│ Pull from backend → channel → callback (external push)     │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│ Tauri                                                       │
│                                                             │
│ callback → app.emit() → SvelteKit                          │
└─────────────────────────────────────────────────────────────┘
```

## Design Principles

- **Internal pull, external push**: Library pulls from backends, pushes to consumers
- **Channels for safety**: Backpressure handled via channel buffers
- **Result-returning callbacks**: Error propagation without separate error channels
- **Consumer simplicity**: No loops, no threading concerns for consumer code
