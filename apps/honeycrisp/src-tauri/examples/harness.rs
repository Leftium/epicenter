//! Drives the shell's close gate from the command line, so the page client's
//! tests run against the real gate. It is a test tool, not part of the app.
//!
//!   harness <step>...
//!
//! One gate, driven in order. Steps: `register`, `opened:<g>`, `request`,
//! `approve:<g>:<r>`, `decline:<g>:<r>`. Prints one line per step:
//! `generation <g>`, `ok`, `refused <text>`, `proceed`, or `ask <g> <r>`.
//! A refusal's text is what the command of the same name returns to the page.

use std::process::ExitCode;

use honeycrisp_lib::close::{CloseGate, Decision, Refusal};

fn settled(result: Result<(), Refusal>) -> String {
    result.map_or_else(
        |refusal| format!("refused {refusal}"),
        |()| "ok".to_string(),
    )
}

fn run(steps: &[String]) -> Result<(), String> {
    let gate = CloseGate::new();
    for step in steps {
        let mut parts = step.split(':');
        let verb = parts.next().unwrap_or("");
        let mut number = || -> Result<u64, String> {
            parts
                .next()
                .and_then(|text| text.parse().ok())
                .ok_or(format!("{step}: a number is missing"))
        };
        let line = match verb {
            "register" => gate.register_page().map_or_else(
                |refusal| format!("refused {refusal}"),
                |generation| format!("generation {generation}"),
            ),
            "opened" => settled(gate.page_opened(number()?)),
            "request" => match gate.request_close() {
                Decision::Proceed => "proceed".to_string(),
                Decision::Ask(ask) => format!("ask {} {}", ask.generation, ask.request),
            },
            "approve" => settled(gate.approve(number()?, number()?)),
            "decline" => settled(gate.decline(number()?, number()?)),
            _ => return Err(format!("{step}: not a gate step")),
        };
        println!("{line}");
    }
    Ok(())
}

fn main() -> ExitCode {
    let steps: Vec<String> = std::env::args().skip(1).collect();
    match run(&steps) {
        Ok(()) => ExitCode::SUCCESS,
        Err(problem) => {
            eprintln!("{problem}");
            ExitCode::from(2)
        }
    }
}
