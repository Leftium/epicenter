//! Hosted Git for account datasets: the native side of the Bun host's relays.
//!
//! Rust holds no Epicenter or GitHub credential. For each transfer it asks the
//! current Bun generation, over that generation's own loopback listener and
//! with its launch token, for one relay (`account-git-relay.ts`), hands Git
//! only the relay's URL, and retires the relay when the transfer ends. Each
//! relay keeps the generation that started it: retirement goes to that
//! generation, and a new transfer always resolves the current one, so a
//! surviving folder owner never holds a dead generation's address.
//!
//! The launch token goes only to the host on `127.0.0.1`: requests here are
//! written directly to a loopback socket, never through a proxy, and the token
//! is never in a URL, a Git argument, or anything sent upstream.

use std::fmt;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};
use tauri_plugin_epicenter_folder::download::{self, DownloadError};
use tauri_plugin_epicenter_folder::transport::{GitService, Relay, Remote, Transport};

use super::binding::{self, Binding, HOSTED_BRANCH};
use crate::device_owner::AccountIdentity;

const CONTROL_PATH: &str = "/_epicenter/native/git";
const RELAY_PATH: &str = "/_epicenter/git-relay/";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(5);
/// A pairing read reaches the hosted connector; starting a relay is local, so
/// this bounds a stuck host rather than a slow network.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(60);
/// Retiring runs before a cancelled Git is stopped, and is local: a host that
/// does not answer quickly must not hold up the cancellation.
const RETIRE_TIMEOUT: Duration = Duration::from_secs(3);
/// Control answers are small JSON documents.
const MAX_ANSWER_BYTES: usize = 1 << 20;

/// One Bun generation's control address.
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct Generation {
    pub port: u16,
    pub token: String,
}

impl fmt::Debug for Generation {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Generation")
            .field("port", &self.port)
            .finish_non_exhaustive()
    }
}

/// The active Bun generation, read when a transfer starts.
pub(crate) type CurrentGeneration = Arc<dyn Fn() -> Option<Generation> + Send + Sync>;

const RESTARTING: &str = "Epicenter is restarting. Try again once it is open.";

#[cfg(test)]
type ScriptedControl = Box<dyn FnMut(&Generation, &str, &Value) -> Result<(u16, Value), String>>;

#[cfg(test)]
thread_local! {
    /// Answers this thread's control requests in place of the host, so a
    /// caller's requests and decisions can be checked without a listener.
    static CONTROL: std::cell::RefCell<Option<ScriptedControl>> =
        std::cell::RefCell::new(None);
}

/// Send one control request to `generation` and read its JSON answer within
/// `timeout`.
fn post(
    generation: &Generation,
    path: &str,
    body: &Value,
    timeout: Duration,
) -> Result<(u16, Value), String> {
    #[cfg(test)]
    if let Some(answer) = CONTROL.with(|control| {
        control
            .borrow_mut()
            .as_mut()
            .map(|answer| answer(generation, path, body))
    }) {
        return answer;
    }
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, generation.port));
    let stream =
        TcpStream::connect_timeout(&address, CONNECT_TIMEOUT.min(timeout)).map_err(|cause| {
            format!("Epicenter's host could not be reached ({cause}). {RESTARTING}")
        })?;
    let unreachable = |cause: std::io::Error| format!("Epicenter's host did not answer ({cause})");
    stream
        .set_read_timeout(Some(timeout))
        .and_then(|()| stream.set_write_timeout(Some(timeout)))
        .map_err(unreachable)?;
    exchange(stream, generation, path, body)
}

/// One HTTP/1.1 request over `stream`, closed after the answer.
fn exchange<S: Read + Write>(
    mut stream: S,
    generation: &Generation,
    path: &str,
    body: &Value,
) -> Result<(u16, Value), String> {
    let body = serde_json::to_vec(body).map_err(|cause| cause.to_string())?;
    let head = format!(
        "POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nAccept: application/json\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n",
        port = generation.port,
        token = generation.token,
        length = body.len(),
    );
    stream
        .write_all(head.as_bytes())
        .and_then(|()| stream.write_all(&body))
        .and_then(|()| stream.flush())
        .map_err(|cause| format!("Epicenter's host did not take the request ({cause})"))?;
    read_answer(&mut BufReader::new(stream))
}

/// Read a status line, headers, and a JSON body: by `Content-Length`, as
/// chunks, or until the connection closes.
fn read_answer(reader: &mut impl BufRead) -> Result<(u16, Value), String> {
    let malformed = || "Epicenter's host answered with something that is not HTTP".to_string();
    let mut line = String::new();
    reader.read_line(&mut line).map_err(|_| malformed())?;
    let status: u16 = line
        .strip_prefix("HTTP/1.1 ")
        .or_else(|| line.strip_prefix("HTTP/1.0 "))
        .and_then(|rest| rest.get(..3))
        .and_then(|code| code.parse().ok())
        .ok_or_else(malformed)?;
    let mut length: Option<usize> = None;
    let mut chunked = false;
    loop {
        line.clear();
        if reader.read_line(&mut line).map_err(|_| malformed())? == 0 {
            return Err(malformed());
        }
        let header = line.trim_end_matches(['\r', '\n']);
        if header.is_empty() {
            break;
        }
        let Some((name, value)) = header.split_once(':') else {
            return Err(malformed());
        };
        let value = value.trim();
        if name.eq_ignore_ascii_case("content-length") {
            length = Some(value.parse().map_err(|_| malformed())?);
        } else if name.eq_ignore_ascii_case("transfer-encoding") {
            chunked = value.eq_ignore_ascii_case("chunked");
        }
    }
    let mut body = Vec::new();
    if chunked {
        loop {
            line.clear();
            reader.read_line(&mut line).map_err(|_| malformed())?;
            let size_text = line.trim_end_matches(['\r', '\n']);
            let size_text = size_text.split(';').next().unwrap_or("");
            let size = usize::from_str_radix(size_text.trim(), 16).map_err(|_| malformed())?;
            if size == 0 {
                break;
            }
            if body.len() + size > MAX_ANSWER_BYTES {
                return Err(malformed());
            }
            let start = body.len();
            body.resize(start + size, 0);
            reader
                .read_exact(&mut body[start..])
                .map_err(|_| malformed())?;
            let mut crlf = [0; 2];
            reader.read_exact(&mut crlf).map_err(|_| malformed())?;
        }
    } else if let Some(length) = length {
        if length > MAX_ANSWER_BYTES {
            return Err(malformed());
        }
        body.resize(length, 0);
        reader.read_exact(&mut body).map_err(|_| malformed())?;
    } else {
        reader
            .take(MAX_ANSWER_BYTES as u64 + 1)
            .read_to_end(&mut body)
            .map_err(|_| malformed())?;
        if body.len() > MAX_ANSWER_BYTES {
            return Err(malformed());
        }
    }
    let value = if body.is_empty() {
        Value::Null
    } else {
        // A plain-text refusal is still an answer with a status.
        serde_json::from_slice(&body).unwrap_or(Value::Null)
    };
    Ok((status, value))
}

/// What a person is told about a refused control request.
fn refusal(status: u16, answer: &Value) -> String {
    if let Some(message) = answer.get("message").and_then(Value::as_str) {
        return message.to_string();
    }
    match status {
        401 => format!("Epicenter's host refused this request. {RESTARTING}"),
        _ => format!("Epicenter's host refused this request ({status})."),
    }
}

/// What the relay saw go wrong, as a sentence, from its retirement answer.
fn failure_message(failure: &Value) -> Option<String> {
    let reason = failure.get("reason")?.as_str()?;
    let code = failure.get("code").and_then(Value::as_str);
    let status = failure.get("status").and_then(Value::as_u64);
    Some(match (reason, code) {
        ("connector", Some("github_authorization_required")) => {
            "Reconnect GitHub for your Epicenter account, then try again.".to_string()
        }
        ("connector", Some("github_account_mismatch")) => {
            "The GitHub account connected now is not the one this folder was paired with.".to_string()
        }
        ("connector", Some("pairing_superseded")) => {
            "This folder's GitHub pairing was replaced since it was downloaded. Epicenter will not sync it with the replacement.".to_string()
        }
        ("connector", Some("pairing_not_found")) => {
            "This folder is no longer paired with a GitHub repository.".to_string()
        }
        ("connector", Some("repository_unavailable" | "repository_mismatch")) => {
            "GitHub no longer gives Epicenter access to this repository.".to_string()
        }
        ("connector", Some("scoped_token_rejected")) => {
            "GitHub refused access for this transfer. Try again.".to_string()
        }
        ("connector", Some("payload_too_large")) => {
            "This transfer is larger than Epicenter's limit.".to_string()
        }
        ("connector", Some("upstream_unavailable")) => {
            "GitHub could not be reached. A push may or may not have landed; fetch to find out.".to_string()
        }
        ("connector", _) => "Epicenter's GitHub connection refused this transfer.".to_string(),
        ("session", _) => "Your Epicenter sign-in needs attention. Sign in again, then retry.".to_string(),
        ("redirect", _) => "Epicenter refused a redirect during this transfer.".to_string(),
        ("unavailable", _) => {
            "Epicenter could not reach its server. Check your connection and try again.".to_string()
        }
        _ => match status {
            Some(status) => format!("Epicenter's server answered {status} during this transfer."),
            None => "Epicenter's server refused this transfer.".to_string(),
        },
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairingAnswer {
    pairing: PairingFields,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PairingFields {
    account: AccountIdentity,
    folder_id: String,
    revision: String,
    repository: RepositoryFields,
    remote: RemoteFields,
}

#[derive(Deserialize)]
struct RepositoryFields {
    id: u64,
}

#[derive(Deserialize)]
struct RemoteFields {
    url: String,
    branch: String,
}

/// Read `folder_id`'s pairing for `account` through `generation`, as the
/// binding a download would record. A read only; nothing is selected here.
pub(crate) fn pairing(
    generation: &Generation,
    account: &AccountIdentity,
    folder_id: &str,
) -> Result<Binding, String> {
    let (status, answer) = post(
        generation,
        &format!("{CONTROL_PATH}/pairing"),
        &json!({ "account": account, "folderId": folder_id }),
        ANSWER_TIMEOUT,
    )?;
    if status != 200 {
        return Err(refusal(status, &answer));
    }
    let unexpected = || "Epicenter's host answered with a pairing it should not have.".to_string();
    let PairingAnswer { pairing } = serde_json::from_value(answer).map_err(|_| unexpected())?;
    // Read for this account and folder, or not adopted at all.
    if pairing.account != *account || pairing.folder_id != folder_id {
        return Err(unexpected());
    }
    if pairing.remote.branch != HOSTED_BRANCH {
        return Err(format!(
            "This folder is paired with the GitHub branch {}. Epicenter downloads {HOSTED_BRANCH} only.",
            pairing.remote.branch
        ));
    }
    Binding::new(
        account.clone(),
        folder_id,
        pairing.repository.id,
        &pairing.revision,
        &pairing.remote.url,
    )
    .map_err(|_| unexpected())
}

#[derive(Deserialize)]
struct StartAnswer {
    relay: StartedRelay,
}

#[derive(Deserialize)]
struct StartedRelay {
    id: String,
    url: String,
}

/// Start one relay for `binding`'s folder and `service` in `generation`. The
/// relay retires itself through that same generation.
pub(crate) fn start_relay(
    generation: Generation,
    binding: &Binding,
    service: GitService,
) -> Result<Relay, String> {
    let (status, answer) = post(
        &generation,
        &format!("{CONTROL_PATH}/relays"),
        &json!({
            "account": binding.account,
            "folderId": binding.folder_id,
            "revision": binding.revision,
            "service": service.as_str(),
        }),
        ANSWER_TIMEOUT,
    )?;
    if status != 200 {
        return Err(refusal(status, &answer));
    }
    let unexpected = || "Epicenter's host answered with a relay it should not have.".to_string();
    let StartAnswer { relay } = serde_json::from_value(answer).map_err(|_| unexpected())?;
    // Git is only ever pointed at this generation's own relay path.
    let prefix = format!("http://127.0.0.1:{}{RELAY_PATH}", generation.port);
    let token = relay
        .url
        .strip_prefix(&prefix)
        .and_then(|rest| rest.strip_suffix("/repo.git"))
        .ok_or_else(unexpected)?;
    if !is_hex(token, 64) || !is_hex(&relay.id, 32) {
        return Err(unexpected());
    }
    let id = relay.id;
    Ok(Relay::new(relay.url, move || retire(&generation, &id)))
}

fn is_hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// Retire one relay in the generation that started it, never a successor.
/// `None` only when that generation confirms it retired the relay itself and
/// saw nothing fail. A relay already gone (its Account was disposed, or the
/// host restarted) or a host that cannot answer leaves the transfer
/// unconfirmed, and that is the report.
fn retire(generation: &Generation, id: &str) -> Option<String> {
    let answer = post(
        generation,
        &format!("{CONTROL_PATH}/relays/{id}/retire"),
        &json!({}),
        RETIRE_TIMEOUT,
    );
    retirement_report(answer)
}

const RELAY_GONE: &str = "Its connection had already ended before Epicenter could confirm it, because the account was signed out or Epicenter restarted.";
const HOST_GONE: &str = "Epicenter's host could not confirm it, because it stopped or restarted.";

/// What a retirement answer says about the transfer it ended.
fn retirement_report(answer: Result<(u16, Value), String>) -> Option<String> {
    match answer {
        Ok((200, answer)) if answer.get("retired") == Some(&Value::Bool(true)) => {
            match answer.get("failure") {
                None | Some(Value::Null) => None,
                Some(failure) => Some(failure_message(failure).unwrap_or_else(|| {
                    "Epicenter's server refused part of this transfer.".to_string()
                })),
            }
        }
        Ok((200, _)) => Some(RELAY_GONE.to_string()),
        Ok((status, _)) => Some(format!(
            "Epicenter's host did not confirm it (it answered {status})."
        )),
        Err(_) => Some(HOST_GONE.to_string()),
    }
}

/// The transport an account dataset's owner uses: one relay per transfer,
/// for the repository the folder's binding names and nothing else.
pub(crate) struct AccountTransport {
    account: AccountIdentity,
    folder_id: String,
    current: CurrentGeneration,
}

impl AccountTransport {
    pub(crate) fn new(
        account: AccountIdentity,
        folder_id: &str,
        current: CurrentGeneration,
    ) -> Self {
        Self {
            account,
            folder_id: folder_id.to_string(),
            current,
        }
    }
}

impl fmt::Debug for AccountTransport {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("AccountTransport")
            .field("folder_id", &self.folder_id)
            .finish_non_exhaustive()
    }
}

impl Transport for AccountTransport {
    /// Admit one transfer, then start its relay. The folder's binding is read
    /// under its lock; the folder's captured origin must be the binding's
    /// canonical URL and branch; and the pairing the account's server holds
    /// now, read through the current generation's boot Account, must be
    /// exactly the binding: account, folder, repository ID, revision, URL,
    /// and branch. The relay forwards to that revision, so a record and a
    /// pairing that disagree never send this folder's history anywhere.
    fn start(&self, root: &Path, remote: &Remote, service: GitService) -> Result<Relay, String> {
        let binding =
            binding::load(root, &self.account, &self.folder_id).map_err(|error| error.message())?;
        if binding.remote.url != remote.url || binding.remote.branch != remote.branch {
            // The origin itself is not repeated: it is not Epicenter's, and a
            // URL someone configured can carry a credential.
            return Err(format!(
                "This folder's origin no longer names the repository it was downloaded from, {}. Epicenter syncs it only with that repository; set origin back to sync again. Editing still works.",
                binding.remote.url
            ));
        }
        let generation = (self.current)().ok_or_else(|| RESTARTING.to_string())?;
        if pairing(&generation, &self.account, &self.folder_id)? != binding {
            return Err(PAIRING_CHANGED.to_string());
        }
        start_relay(generation, &binding, service)
    }
}

const PAIRING_CHANGED: &str = "This folder's GitHub pairing no longer matches the repository it was downloaded from, so Epicenter will not sync it. Editing still works.";

/// Download `account`'s `folder_id` into `<parent>/<folder_id>` from the
/// repository its pairing names now, and record that selection in the folder.
/// `parent` is the account's canonical directory. Returns the published root.
pub(crate) fn download_dataset(
    parent: &Path,
    account: &AccountIdentity,
    folder_id: &str,
    current: &CurrentGeneration,
    cancel: &AtomicBool,
) -> Result<PathBuf, String> {
    let generation = current().ok_or_else(|| RESTARTING.to_string())?;
    let binding = pairing(&generation, account, folder_id)?;
    let remote = Remote {
        url: binding.remote.url.clone(),
        branch: binding.remote.branch.clone(),
    };
    let relayed = binding.clone();
    download::download(
        parent,
        folder_id,
        &remote,
        move || start_relay(generation, &relayed, GitService::UploadPack),
        cancel,
        |staging| binding::write_new(staging, &binding),
    )
    .map(|downloaded| downloaded.root)
    .map_err(download_message)
}

/// What a person is told when a download was stopped just as its folder was
/// put in place: the bytes stay, and nothing opens them on its own.
pub(crate) fn interrupted_message(root: &Path) -> String {
    format!(
        "The download was stopped as its folder was put in place at {}, so it was not opened. The folder is complete and stays there; open the app once Epicenter is running to use it.",
        root.display()
    )
}

/// What a person is told when a download did not produce a ready folder.
fn download_message(error: DownloadError) -> String {
    match error {
        DownloadError::Exists { path } => format!(
            "This app's data is already on this device at {}. Nothing was downloaded over it.",
            path.display()
        ),
        DownloadError::Busy { .. } => {
            "Another program is using this app's data folder. Close it, then try again.".to_string()
        }
        DownloadError::Unsupported { message } => message,
        DownloadError::Cancelled => "The download was cancelled. Nothing was saved.".to_string(),
        DownloadError::Interrupted { root } => interrupted_message(&root),
        DownloadError::Failed {
            message,
            staging: Some(staging),
        } => format!(
            "{message}. Nothing was opened; what was downloaded was kept at {} so it can be inspected.",
            staging.display()
        ),
        DownloadError::Failed {
            message,
            staging: None,
        } => message,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    /// A stream that records what is written and answers with fixed bytes.
    struct Scripted {
        written: Vec<u8>,
        answer: Cursor<Vec<u8>>,
    }

    impl Scripted {
        fn new(answer: &str) -> Self {
            Self {
                written: Vec::new(),
                answer: Cursor::new(answer.as_bytes().to_vec()),
            }
        }
    }

    impl Read for Scripted {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            self.answer.read(buffer)
        }
    }

    impl Write for Scripted {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.written.extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn generation() -> Generation {
        Generation {
            port: 39_130,
            token: "launch-token".to_string(),
        }
    }

    #[test]
    fn a_control_request_carries_the_launch_token_only_in_its_header_to_the_exact_host() {
        let mut stream = Scripted::new(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{\"ok\":true}",
        );
        let (status, answer) = exchange(
            &mut stream,
            &generation(),
            "/_epicenter/native/git/relays",
            &json!({ "a": 1 }),
        )
        .unwrap();
        assert_eq!(status, 200);
        assert_eq!(answer, json!({ "ok": true }));
        let written = String::from_utf8(stream.written).unwrap();
        assert!(written.starts_with("POST /_epicenter/native/git/relays HTTP/1.1\r\nHost: 127.0.0.1:39130\r\nAuthorization: Bearer launch-token\r\n"), "{written}");
        assert!(written.ends_with("\r\n\r\n{\"a\":1}"), "{written}");
        assert_eq!(written.matches("launch-token").count(), 1);
        assert!(!written.to_lowercase().contains("origin:"));
        assert!(!written.to_lowercase().contains("cookie:"));
    }

    #[test]
    fn answers_are_read_by_length_by_chunks_or_to_the_end() {
        for (raw, expected) in [
            (
                "HTTP/1.1 409 Conflict\r\ncontent-length: 25\r\n\r\n{\"error\":\"signed-out\"}   ",
                (409, json!({ "error": "signed-out" })),
            ),
            (
                "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n6\r\n{\"a\":1\r\n1\r\n}\r\n0\r\n\r\n",
                (200, json!({ "a": 1 })),
            ),
            ("HTTP/1.1 401 Unauthorized\r\n\r\nUnauthorized", (401, Value::Null)),
            ("HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n", (204, Value::Null)),
        ] {
            assert_eq!(read_answer(&mut BufReader::new(raw.as_bytes())).unwrap(), expected, "{raw}");
        }
        for raw in [
            "",
            "SSH-2.0\r\n",
            "HTTP/1.1 200 OK\r\nbroken\r\n\r\n",
            "HTTP/1.1 200 OK\r\n",
        ] {
            assert!(
                read_answer(&mut BufReader::new(raw.as_bytes())).is_err(),
                "{raw:?}"
            );
        }
        let huge = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
            MAX_ANSWER_BYTES + 1
        );
        assert!(read_answer(&mut BufReader::new(huge.as_bytes())).is_err());
    }

    #[test]
    fn refusals_and_relay_failures_become_plain_sentences_without_identifiers() {
        assert_eq!(
            refusal(409, &json!({ "error": "account-mismatch", "message": "This folder belongs to a different Epicenter account than the one signed in. Quit and reopen Epicenter." })),
            "This folder belongs to a different Epicenter account than the one signed in. Quit and reopen Epicenter."
        );
        assert!(refusal(401, &Value::Null).contains("restarting"));
        for (failure, expected) in [
            (
                json!({ "reason": "connector", "status": 409, "code": "pairing_superseded" }),
                "replaced",
            ),
            (
                json!({ "reason": "connector", "status": 403, "code": "scoped_token_rejected" }),
                "GitHub refused",
            ),
            (
                json!({ "reason": "connector", "status": 403, "code": "github_authorization_required" }),
                "Reconnect GitHub",
            ),
            (json!({ "reason": "session", "status": 401 }), "sign-in"),
            (json!({ "reason": "redirect", "status": 307 }), "redirect"),
            (json!({ "reason": "http", "status": 504 }), "504"),
        ] {
            let message = failure_message(&failure).unwrap();
            assert!(message.contains(expected), "{message}");
        }
        assert_eq!(failure_message(&json!({})), None);
    }

    #[test]
    fn only_this_generations_relay_path_is_ever_given_to_git() {
        assert!(is_hex(&"a".repeat(64), 64));
        assert!(!is_hex(&"A".repeat(64), 64));
        assert!(!is_hex(&"a".repeat(63), 64));
        assert_eq!(
            format!("{:?}", generation()),
            "Generation { port: 39130, .. }"
        );
    }

    const FOLDER: &str = "com.bradenwong.zhongwen";
    const URL: &str = "https://github.com/alice/zhongwen.git";
    const REVISION: &str = "AbCdEfGhIjKlMnOpQrSt_-";
    const RELAY_TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const RELAY_ID: &str = "00112233445566778899aabbccddeeff";

    fn alice() -> AccountIdentity {
        AccountIdentity {
            authority_id: "epicenter-api".into(),
            principal_id: "user-123".into(),
        }
    }

    /// A folder with a real `.git`, removed when dropped.
    struct Folder(PathBuf);

    impl Drop for Folder {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn folder(label: &str) -> Folder {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "epicenter-hosted-{label}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join(".git")).unwrap();
        Folder(root)
    }

    fn bound(root: &Path, repository_id: u64, revision: &str) {
        binding::write_new(
            root,
            &Binding::new(alice(), FOLDER, repository_id, revision, URL).unwrap(),
        )
        .unwrap();
    }

    fn canonical() -> Remote {
        Remote {
            url: URL.into(),
            branch: "main".into(),
        }
    }

    fn transport(current: Option<Generation>) -> AccountTransport {
        AccountTransport::new(alice(), FOLDER, Arc::new(move || current.clone()))
    }

    /// The host's pairing answer for this folder, as the relay owner sends it.
    fn pairing_answer(repository_id: u64, revision: &str, url: &str) -> Value {
        json!({ "pairing": {
            "account": { "authorityId": "epicenter-api", "principalId": "user-123" },
            "folderId": FOLDER,
            "revision": revision,
            "repository": { "id": repository_id, "installationId": 7001, "fullName": "alice/zhongwen" },
            "remote": { "url": url, "branch": "main" },
        } })
    }

    /// Answer control requests with `pairing` and a relay of `generation`,
    /// recording each request's path and body.
    fn script(pairing: Value) -> Arc<std::sync::Mutex<Vec<(String, Value)>>> {
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let recording = Arc::clone(&seen);
        CONTROL.with(|control| {
            *control.borrow_mut() = Some(Box::new(move |generation, path, body| {
                recording
                    .lock()
                    .unwrap()
                    .push((path.to_string(), body.clone()));
                Ok(match path {
                    "/_epicenter/native/git/pairing" => (200, pairing.clone()),
                    "/_epicenter/native/git/relays" => (
                        200,
                        json!({ "relay": {
                            "id": RELAY_ID,
                            "url": format!("http://127.0.0.1:{}/_epicenter/git-relay/{RELAY_TOKEN}/repo.git", generation.port),
                        } }),
                    ),
                    _ => (200, json!({ "retired": true })),
                })
            }));
        });
        seen
    }

    fn unscript() {
        CONTROL.with(|control| control.borrow_mut().take());
    }

    fn paths(seen: &std::sync::Mutex<Vec<(String, Value)>>) -> Vec<String> {
        seen.lock()
            .unwrap()
            .iter()
            .map(|(path, _)| path.clone())
            .collect()
    }

    #[test]
    fn a_transfer_starts_only_when_the_current_pairing_is_exactly_the_saved_binding() {
        let root = folder("admitted");
        bound(&root.0, 9001, REVISION);
        let seen = script(pairing_answer(9001, REVISION, URL));
        let relay = transport(Some(generation()))
            .start(&root.0, &canonical(), GitService::ReceivePack)
            .unwrap();
        assert!(relay.url().ends_with(&format!("/{RELAY_TOKEN}/repo.git")));
        assert!(!format!("{relay:?}").contains(RELAY_TOKEN));
        drop(relay);
        assert_eq!(
            paths(&seen),
            vec![
                "/_epicenter/native/git/pairing".to_string(),
                "/_epicenter/native/git/relays".to_string(),
                format!("/_epicenter/native/git/relays/{RELAY_ID}/retire"),
            ]
        );
        // The relay is asked for the saved revision and this one service.
        assert_eq!(
            seen.lock().unwrap()[1].1,
            json!({
                "account": { "authorityId": "epicenter-api", "principalId": "user-123" },
                "folderId": FOLDER,
                "revision": REVISION,
                "service": "git-receive-pack",
            })
        );
        unscript();
    }

    /// Only the original generation's own confirmation is a clean ending.
    #[test]
    fn a_retirement_is_clean_only_when_the_original_generation_confirms_it() {
        assert_eq!(
            retirement_report(Ok((200, json!({ "retired": true })))),
            None
        );
        for (answer, expected) in [
            (Ok((200, json!({ "retired": false }))), "already ended"),
            (Ok((200, json!({}))), "already ended"),
            (Ok((401, Value::Null)), "answered 401"),
            (Ok((503, json!({ "retired": true }))), "answered 503"),
            (Err("connection refused".to_string()), "could not confirm"),
            (
                Ok((
                    200,
                    json!({ "retired": true, "failure": { "reason": "connector", "status": 403, "code": "scoped_token_rejected" } }),
                )),
                "GitHub refused",
            ),
            (
                Ok((
                    200,
                    json!({ "retired": true, "failure": { "unexpected": true } }),
                )),
                "refused part",
            ),
        ] {
            let report = retirement_report(answer).expect("not a clean ending");
            assert!(report.contains(expected), "{report}");
        }
    }

    /// A relay whose Account was disposed after Git finished: its original
    /// generation no longer has it, so retiring it reports that, and the
    /// retirement goes to that generation even after another is current.
    #[test]
    fn a_relay_already_gone_at_retirement_is_reported_to_its_caller() {
        let root = folder("gone");
        bound(&root.0, 9001, REVISION);
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let recording = Arc::clone(&seen);
        CONTROL.with(|control| {
            *control.borrow_mut() = Some(Box::new(move |generation: &Generation, path: &str, _: &Value| {
                recording.lock().unwrap().push((generation.token.clone(), path.to_string()));
                Ok(match path {
                    "/_epicenter/native/git/pairing" => (200, pairing_answer(9001, REVISION, URL)),
                    "/_epicenter/native/git/relays" => (
                        200,
                        json!({ "relay": {
                            "id": RELAY_ID,
                            "url": format!("http://127.0.0.1:{}/_epicenter/git-relay/{RELAY_TOKEN}/repo.git", generation.port),
                        } }),
                    ),
                    _ => (200, json!({ "retired": false })),
                })
            }));
        });
        let relay = transport(Some(generation()))
            .start(&root.0, &canonical(), GitService::UploadPack)
            .unwrap();
        let report = relay
            .retire()
            .expect("an ended relay is not a confirmed transfer");
        assert!(
            report.contains("signed out or Epicenter restarted"),
            "{report}"
        );
        assert!(!report.contains(RELAY_TOKEN), "{report}");
        assert!(seen
            .lock()
            .unwrap()
            .iter()
            .all(|(token, _)| token == "launch-token"));
        unscript();
    }

    /// A private record edited to name repository A at revision B, or a
    /// pairing replaced since the download, never reaches a relay.
    #[test]
    fn a_pairing_that_differs_from_the_binding_in_any_field_starts_no_relay() {
        for (label, answer) in [
            (
                "another repository at the same URL",
                pairing_answer(9002, REVISION, URL),
            ),
            (
                "a replaced pairing",
                pairing_answer(9001, "ZZZZZZZZZZZZZZZZZZZZZZ", URL),
            ),
            (
                "a renamed repository",
                pairing_answer(9001, REVISION, "https://github.com/alice/renamed.git"),
            ),
        ] {
            let root = folder("mismatch");
            bound(&root.0, 9001, REVISION);
            let seen = script(answer);
            let error = transport(Some(generation()))
                .start(&root.0, &canonical(), GitService::ReceivePack)
                .unwrap_err();
            assert_eq!(error, PAIRING_CHANGED, "{label}");
            assert_eq!(
                paths(&seen),
                vec!["/_epicenter/native/git/pairing"],
                "{label}"
            );
            unscript();
        }
    }

    #[test]
    fn a_pairing_the_host_refuses_starts_no_relay_and_says_why() {
        let root = folder("refused");
        bound(&root.0, 9001, REVISION);
        let seen = Arc::new(std::sync::Mutex::new(0));
        let counted = Arc::clone(&seen);
        CONTROL.with(|control| {
            *control.borrow_mut() = Some(Box::new(move |_, _, _| {
                *counted.lock().unwrap() += 1;
                Ok((
                    409,
                    json!({ "error": "not-ready", "message": "Reconnect GitHub for your Epicenter account, then try again." }),
                ))
            }));
        });
        let error = transport(Some(generation()))
            .start(&root.0, &canonical(), GitService::UploadPack)
            .unwrap_err();
        assert_eq!(
            error,
            "Reconnect GitHub for your Epicenter account, then try again."
        );
        assert_eq!(*seen.lock().unwrap(), 1);
        unscript();
    }

    #[test]
    fn a_folder_without_a_matching_binding_and_origin_asks_the_host_nothing() {
        let root = folder("unbound");
        let asked = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counted = Arc::clone(&asked);
        CONTROL.with(|control| {
            *control.borrow_mut() = Some(Box::new(move |_, _, _| {
                counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                Err("unreachable".into())
            }));
        });
        let error = transport(Some(generation()))
            .start(&root.0, &canonical(), GitService::ReceivePack)
            .unwrap_err();
        assert!(error.contains("Editing still works"), "{error}");

        // An origin that is not the binding's is refused without repeating
        // it: a configured URL can carry a credential.
        bound(&root.0, 9001, REVISION);
        let changed = Remote {
            url: "https://person:secret@github.com/alice/zhongwen.git".into(),
            branch: "main".into(),
        };
        let error = transport(Some(generation()))
            .start(&root.0, &changed, GitService::UploadPack)
            .unwrap_err();
        assert!(
            error.contains(&format!("downloaded from, {URL}")),
            "{error}"
        );
        assert!(
            !error.contains("secret") && !error.contains("person"),
            "{error}"
        );
        assert_eq!(asked.load(std::sync::atomic::Ordering::SeqCst), 0);

        // With a matching origin and no running host, nothing is asked either.
        assert_eq!(
            transport(None)
                .start(&root.0, &canonical(), GitService::UploadPack)
                .unwrap_err(),
            RESTARTING
        );
        assert_eq!(asked.load(std::sync::atomic::Ordering::SeqCst), 0);
        unscript();
    }

    /// The real socket path, where a listener can be bound: the request on
    /// the wire carries the exact Host and the launch token, and no Origin or
    /// cookie. Skipped with a note where this environment refuses a listener;
    /// `EPICENTER_REQUIRE_LOOPBACK=1` makes that a failure.
    #[test]
    fn a_control_request_on_a_real_socket_names_the_exact_host_and_token() {
        let listener = match std::net::TcpListener::bind(("127.0.0.1", 0)) {
            Ok(listener) => listener,
            Err(cause) => {
                if std::env::var_os("EPICENTER_REQUIRE_LOOPBACK").is_some() {
                    panic!("needs a loopback listener: {cause}");
                }
                eprintln!("SKIPPED a_control_request_on_a_real_socket: {cause}");
                return;
            }
        };
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut head = String::new();
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" || line.is_empty() {
                    break;
                }
                head.push_str(&line);
            }
            // Consume this request's body before closing the connection;
            // unread request bytes can reset TCP and discard the response.
            let mut request_body = [0; 2];
            reader.read_exact(&mut request_body).unwrap();
            assert_eq!(&request_body, b"{}");
            let body = "{\"retired\":false}";
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
            head
        });
        let generation = Generation {
            port,
            token: "launch-token".into(),
        };
        let (status, answer) = post(
            &generation,
            "/_epicenter/native/git/relays/x/retire",
            &json!({}),
            RETIRE_TIMEOUT,
        )
        .unwrap();
        assert_eq!((status, answer), (200, json!({ "retired": false })));
        let head = server.join().unwrap().to_lowercase();
        assert!(
            head.contains(&format!("host: 127.0.0.1:{port}\r\n")),
            "{head}"
        );
        assert!(
            head.contains("authorization: bearer launch-token\r\n"),
            "{head}"
        );
        assert!(
            !head.contains("origin:") && !head.contains("cookie:"),
            "{head}"
        );
    }
}
