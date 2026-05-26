pub mod artifact;
pub mod commands;
pub mod recorder;
pub mod sink;
pub mod wav_writer;

// Export everything from commands for easy access
pub use commands::{
    cancel_recording, close_recording_session, enumerate_recording_devices,
    get_current_recording_id, init_recording_session, start_recording, stop_recording,
};

// Export key types
pub use artifact::{AudioArtifact, RecorderMode};
pub use recorder::Recorder;
