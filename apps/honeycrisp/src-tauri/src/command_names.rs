/// Every command the Honeycrisp shell exposes. The build script generates a
/// permission for each, and a test checks the list against the registered
/// handlers and the window's capability.
pub const COMMANDS: &[&str] = &[
    "close_register",
    "close_opened",
    "close_approve",
    "close_decline",
    "shell_info",
    "terminal_run",
    "file_log",
    "file_show",
    "reveal_folder",
];
