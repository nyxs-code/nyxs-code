//! Several accounts per agent CLI, kept the way zeron keeps them. Each CLI has one live sign-in
//! in its own files; Nyxs saves a copy of every account it sees there (a "slot", in
//! `~/.nyxs/agent-accounts/<cli>/`) and switches by writing a saved copy back. A new account
//! signs in through the CLI's own login pointed at a throwaway home (`CLAUDE_CONFIG_DIR`,
//! `CODEX_HOME`, `GROK_HOME`), so the live one isn't touched until the user switches to it.
//!
//! Claude Code, Codex and Grok keep their sign-in where it can be swapped. Antigravity keeps
//! no identity next to its token and Cursor's session isn't a file: they show their one
//! account only (see `agent_cli_status`).

use super::claude_code::{locate_claude, open_terminal, with_login_refresh_held};
use super::*;
use crate::error::CmdError;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum AccountCli {
    Claude,
    Codex,
    Grok,
}

impl AccountCli {
    fn parse(s: &str) -> Result<Self, String> {
        match s {
            "claude-code" => Ok(Self::Claude),
            "codex" => Ok(Self::Codex),
            "grok" => Ok(Self::Grok),
            other => Err(format!("{other} doesn't keep several accounts")),
        }
    }

    fn slug(self) -> &'static str {
        match self {
            Self::Claude => "claude-code",
            Self::Codex => "codex",
            Self::Grok => "grok",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Claude => "Claude Code",
            Self::Codex => "Codex CLI",
            Self::Grok => "Grok CLI",
        }
    }

    /// The variable that points the CLI at another home, for a sign-in that must not touch
    /// the live one.
    fn home_env(self) -> &'static str {
        match self {
            Self::Claude => "CLAUDE_CONFIG_DIR",
            Self::Codex => "CODEX_HOME",
            Self::Grok => "GROK_HOME",
        }
    }

    fn login_args(self) -> &'static str {
        match self {
            Self::Claude => "auth login",
            Self::Codex | Self::Grok => "login",
        }
    }

    fn locate(self) -> Option<PathBuf> {
        match self {
            Self::Claude => locate_claude(),
            Self::Codex => agent_cli::locate_agent_cli("codex"),
            Self::Grok => agent_cli::locate_agent_cli("grok"),
        }
    }
}

/// One account as the settings list it.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CliAccountRow {
    id: String,
    email: String,
    name: Option<String>,
    plan: Option<String>,
    /// The account the CLI is signed in with now.
    active: bool,
}

/// A saved account (`<id>.json`): its identity and the sign-in to write back on a switch.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct Slot {
    id: String,
    /// Who the account is for the provider (account uuid, user id or email).
    account_key: String,
    email: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    plan: Option<String>,
    /// Claude: the credentials blob. Codex: `auth.json`. Grok: its issuer's entry.
    credentials: Value,
    /// Claude only: `{oauthAccount, userID}`, merged into `.claude.json` on a switch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    claude_config: Option<Value>,
    /// Grok only: the `auth.json` key (`issuer::client`) its entry lives under.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    store_key: Option<String>,
    saved_at: i64,
    /// When it was first saved: the list's order, which switching never changes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    created_at: Option<i64>,
}

impl Slot {
    fn row(&self, active: bool) -> CliAccountRow {
        CliAccountRow {
            id: self.id.clone(),
            email: self.email.clone(),
            name: self.name.clone(),
            plan: self.plan.clone(),
            active,
        }
    }
}

/// A sign-in found in a CLI's files, before it's saved.
#[derive(Debug, Clone)]
struct Detected {
    account_key: String,
    email: String,
    name: Option<String>,
    plan: Option<String>,
    credentials: Value,
    claude_config: Option<Value>,
    store_key: Option<String>,
}

// ── small helpers ───────────────────────────────────────────────────────────

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn env_dir(var: &str) -> Option<PathBuf> {
    std::env::var_os(var)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

/// A JSON object from a file; anything else (missing, torn, not an object) is None.
fn read_json_object(path: &Path) -> Option<Value> {
    let value: Value = serde_json::from_slice(&fs::read(path).ok()?).ok()?;
    value.is_object().then_some(value)
}

fn str_of(v: &Value, key: &str) -> Option<String> {
    v.get(key)?
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn slot_id_for(cli: AccountCli, account_key: &str) -> String {
    hex(&Sha256::digest(
        format!("{}:{account_key}", cli.slug()).as_bytes(),
    ))[..16]
        .to_string()
}

/// Ids come from the page and become file names: only what `slot_id_for` makes is accepted.
fn valid_id(id: &str) -> bool {
    id.len() == 16
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn root_dir() -> Result<PathBuf, String> {
    Ok(home_dir()?.join(".nyxs").join("agent-accounts"))
}

/// A folder only the user can read: it holds sign-in tokens.
fn private_dir(dir: &Path) -> Result<(), String> {
    fs::create_dir_all(dir).map_err(|e| format!("Couldn't create {}: {e}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
    }
    Ok(())
}

/// Written whole or not at all, and readable by the user alone: it holds tokens.
pub(super) fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("Couldn't create {}: {e}", dir.display()))?;
    }
    text_io::write_atomic(path, bytes)
        .map_err(|e| format!("Couldn't write {}: {e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

fn codex_home() -> Result<PathBuf, String> {
    Ok(env_dir("CODEX_HOME").unwrap_or(home_dir()?.join(".codex")))
}

fn grok_home() -> Result<PathBuf, String> {
    Ok(env_dir("GROK_HOME").unwrap_or(home_dir()?.join(".grok")))
}

// ── Claude Code's sign-in (Keychain on macOS, a file elsewhere) ─────────────

/// Machine-wide entries Claude Code keeps next to the account's login (MCP servers' and
/// plugins' OAuth): on a switch the live ones stay, or every MCP server would sign in again.
const CLAUDE_SHARED_CREDENTIAL_KEYS: &[&str] = &[
    "mcpOAuth",
    "mcpOAuthClientConfig",
    "mcpXaaIdp",
    "mcpXaaIdpConfig",
    "pluginSecrets",
];

/// Where one Claude Code config keeps its sign-in: `.credentials.json` in its folder (or, on
/// macOS, a Keychain item named after the folder) and the identity in `.claude.json`.
struct ClaudeStore {
    dir: PathBuf,
    config_file: PathBuf,
    keychain_service: Option<String>,
}

impl ClaudeStore {
    fn live() -> Result<Self, String> {
        let custom = env_dir("CLAUDE_CONFIG_DIR");
        let home = home_dir()?;
        Ok(Self {
            config_file: match &custom {
                Some(dir) => dir.join(".claude.json"),
                None => home.join(".claude.json"),
            },
            keychain_service: cfg!(target_os = "macos")
                .then(|| claude_keychain_service(custom.as_deref())),
            dir: custom.unwrap_or_else(|| home.join(".claude")),
        })
    }

    /// A config Claude Code was pointed at with `CLAUDE_CONFIG_DIR` (a new account's sign-in).
    fn at(dir: &Path) -> Self {
        Self {
            dir: dir.to_path_buf(),
            config_file: dir.join(".claude.json"),
            keychain_service: cfg!(target_os = "macos").then(|| claude_keychain_service(Some(dir))),
        }
    }

    fn credentials_file(&self) -> PathBuf {
        self.dir.join(".credentials.json")
    }

    /// Where Claude Code itself reads it: the Keychain first, the file only without an item.
    fn read_credentials(&self) -> Option<Value> {
        if let Some(service) = &self.keychain_service {
            if let Some(creds) = keychain_read(service) {
                return Some(creds);
            }
        }
        read_json_object(&self.credentials_file())
    }

    fn write_credentials(&self, creds: &Value) -> Result<(), String> {
        let text = creds.to_string();
        if let Some(service) = &self.keychain_service {
            let has_item = keychain_has(service);
            if has_item || !self.credentials_file().exists() {
                match keychain_write(service, &text) {
                    Ok(()) => return Ok(()),
                    // An item that can't be updated would hide the file, which is read second.
                    Err(e) if has_item => return Err(e),
                    Err(_) => {}
                }
            }
        }
        write_private(&self.credentials_file(), text.as_bytes())
    }
}

/// Claude Code's Keychain item: `Claude Code-credentials`, suffixed with the first 8 hex of
/// sha256(config folder) when `CLAUDE_CONFIG_DIR` points elsewhere.
fn claude_keychain_service(config_dir: Option<&Path>) -> String {
    match config_dir {
        None => "Claude Code-credentials".to_string(),
        Some(dir) => format!(
            "Claude Code-credentials-{}",
            &hex(&Sha256::digest(dir.to_string_lossy().as_bytes()))[..8]
        ),
    }
}

const KEYCHAIN_TIMEOUT: Duration = Duration::from_secs(15);

/// `/usr/bin/security` (macOS only), bounded: an unanswered Keychain prompt blocks it forever.
fn security(args: &[&str]) -> Option<(i32, String)> {
    let mut child = Command::new("/usr/bin/security")
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut text = String::new();
        let _ = stdout.read_to_string(&mut text);
        text
    });
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if start.elapsed() < KEYCHAIN_TIMEOUT => {
                std::thread::sleep(Duration::from_millis(50))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };
    Some((
        status.code().unwrap_or(-1),
        reader.join().unwrap_or_default(),
    ))
}

fn keychain_account() -> String {
    std::env::var("USER").unwrap_or_else(|_| "unknown".into())
}

fn keychain_has(service: &str) -> bool {
    security(&["find-generic-password", "-s", service]).is_some_and(|(code, _)| code == 0)
}

fn keychain_read(service: &str) -> Option<Value> {
    if !keychain_has(service) {
        return None;
    }
    let account = keychain_account();
    let (code, out) = security(&["find-generic-password", "-a", &account, "-s", service, "-w"])?;
    if code != 0 {
        return None;
    }
    serde_json::from_str::<Value>(out.trim())
        .ok()
        .filter(Value::is_object)
}

fn keychain_write(service: &str, json: &str) -> Result<(), String> {
    let account = keychain_account();
    match security(&[
        "add-generic-password",
        "-U",
        "-a",
        &account,
        "-s",
        service,
        "-w",
        json,
    ]) {
        Some((0, _)) => Ok(()),
        _ => Err("macOS Keychain wouldn't save the Claude Code login".into()),
    }
}

fn keychain_delete(service: &str) {
    let _ = security(&["delete-generic-password", "-s", service]);
}

/// "Max 5×" from Claude's organization type and rate-limit tier.
fn claude_plan(org_type: Option<&str>, tier: Option<&str>) -> Option<String> {
    let base = match org_type? {
        "claude_max" => "Max",
        "claude_pro" => "Pro",
        "claude_team" => "Team",
        "claude_enterprise" => "Enterprise",
        _ => return None,
    };
    let mult = tier.and_then(|t| {
        let stem = t.strip_suffix('x')?;
        let digits: String = stem
            .chars()
            .rev()
            .take_while(char::is_ascii_digit)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        let preceded = stem.len() > digits.len()
            && stem.as_bytes().get(stem.len() - digits.len() - 1) == Some(&b'_');
        (!digits.is_empty() && preceded).then_some(digits)
    });
    Some(match mult {
        Some(mult) => format!("{base} {mult}×"),
        None => base.to_string(),
    })
}

fn detect_claude(store: &ClaudeStore) -> Option<Detected> {
    let cfg = read_json_object(&store.config_file)?;
    let oauth = cfg.get("oauthAccount")?.clone();
    let email = str_of(&oauth, "emailAddress")?;
    let credentials = store.read_credentials()?;
    credentials.get("claudeAiOauth")?;
    let mut claude_config = json!({ "oauthAccount": oauth });
    if let Some(uid) = cfg.get("userID").filter(|v| v.is_string()) {
        claude_config["userID"] = uid.clone();
    }
    Some(Detected {
        account_key: str_of(&oauth, "accountUuid").unwrap_or_else(|| email.clone()),
        name: str_of(&oauth, "displayName"),
        plan: claude_plan(
            str_of(&oauth, "organizationType").as_deref(),
            str_of(&oauth, "organizationRateLimitTier").as_deref(),
        ),
        email,
        credentials,
        claude_config: Some(claude_config),
        store_key: None,
    })
}

/// The account's login from the slot, with the machine's shared entries (MCP OAuth) as they
/// are live now: present or absent alike.
fn compose_claude_credentials(target: &Value, live: Option<&Value>) -> Value {
    let (Some(live), Some(target_obj)) = (live.and_then(Value::as_object), target.as_object())
    else {
        return target.clone();
    };
    if !target_obj.contains_key("claudeAiOauth") {
        return target.clone();
    }
    let mut composed: serde_json::Map<String, Value> = target_obj
        .iter()
        .filter(|(k, _)| !CLAUDE_SHARED_CREDENTIAL_KEYS.contains(&k.as_str()))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    for key in CLAUDE_SHARED_CREDENTIAL_KEYS {
        if let Some(value) = live.get(*key) {
            composed.insert((*key).to_string(), value.clone());
        }
    }
    Value::Object(composed)
}

/// Whether `candidate` holds an older rotation of the login than `saved`: another refresh
/// token whose access token expires sooner. Its refresh token is spent; saving it over the
/// newer one would make switching back sign the account out.
fn claude_login_is_older(candidate: &Value, saved: &Value) -> bool {
    let pair = |creds: &Value| {
        let oauth = creds.get("claudeAiOauth")?;
        let refresh = str_of(oauth, "refreshToken")?;
        let expires = oauth.get("expiresAt")?.as_i64().filter(|ms| *ms > 0)?;
        Some((refresh, expires))
    };
    match (pair(candidate), pair(saved)) {
        (Some((cand_refresh, cand_expires)), Some((saved_refresh, saved_expires))) => {
            cand_refresh != saved_refresh && cand_expires < saved_expires
        }
        _ => false,
    }
}

// ── Codex and Grok ──────────────────────────────────────────────────────────

/// A JWT's claims, unverified: only who it names is read, from a token the CLI already trusts.
fn jwt_claims(jwt: &str) -> Option<Value> {
    use base64::Engine;
    let payload = jwt.split('.').nth(1)?.trim_end_matches('=');
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Codex's `auth.json`: a ChatGPT sign-in (identity in its `id_token`) or an API key.
fn parse_codex_auth(auth: Value) -> Option<Detected> {
    if let Some(id_token) = auth
        .get("tokens")
        .and_then(|t| t.get("id_token"))
        .and_then(Value::as_str)
    {
        let claims = jwt_claims(id_token).unwrap_or_else(|| json!({}));
        let openai = claims
            .get("https://api.openai.com/auth")
            .cloned()
            .unwrap_or_default();
        let email = str_of(&claims, "email")?;
        // A Team workspace's seats share its id: the user id tells them apart.
        let workspace = str_of(&openai, "chatgpt_account_id");
        let user = str_of(&openai, "chatgpt_user_id").or_else(|| str_of(&openai, "user_id"));
        let account_key = match (user, workspace) {
            (Some(user), Some(workspace)) => format!("{user}::{workspace}"),
            (None, Some(workspace)) => workspace,
            _ => email.clone(),
        };
        return Some(Detected {
            account_key,
            name: str_of(&claims, "name"),
            plan: str_of(&openai, "chatgpt_plan_type").and_then(|p| agent_cli::plan_words(&p)),
            email,
            credentials: auth,
            claude_config: None,
            store_key: None,
        });
    }
    let key = str_of(&auth, "OPENAI_API_KEY")?;
    let tail: String = key
        .chars()
        .skip(key.chars().count().saturating_sub(4))
        .collect();
    Some(Detected {
        account_key: format!("api-key:{}", &hex(&Sha256::digest(key.as_bytes()))[..12]),
        email: format!("API key ·…{tail}"),
        name: None,
        plan: Some("API key".into()),
        credentials: auth,
        claude_config: None,
        store_key: None,
    })
}

/// Grok's `auth.json`: one token set per issuer; the x.ai one is the account.
fn parse_grok_auth(auth: Value) -> Option<Detected> {
    let identity = |e: &Value| {
        str_of(e, "user_id")
            .or_else(|| str_of(e, "principal_id"))
            .or_else(|| str_of(e, "email"))
    };
    let (map_key, entry) = auth
        .as_object()?
        .iter()
        .filter(|(_, e)| str_of(e, "key").is_some())
        .max_by_key(|(map_key, e)| {
            let issuer = str_of(e, "oidc_issuer").unwrap_or_else(|| (*map_key).clone());
            (
                issuer.starts_with("https://auth.x.ai"),
                identity(e).is_some(),
            )
        })?;
    let name = [str_of(entry, "first_name"), str_of(entry, "last_name")]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" ");
    Some(Detected {
        account_key: identity(entry).unwrap_or_else(|| format!("oidc:{map_key}")),
        email: str_of(entry, "email")
            .or_else(|| identity(entry))
            .unwrap_or_else(|| "Grok".into()),
        name: (!name.is_empty()).then_some(name),
        plan: str_of(entry, "subscription_tier").and_then(|t| agent_cli::plan_words(&t)),
        credentials: entry.clone(),
        claude_config: None,
        store_key: Some(map_key.clone()),
    })
}

/// Grok's own lock on its `auth.json` (`auth.json.lock`), held while Nyxs rewrites the file.
fn with_grok_lock<T>(home: &Path, f: impl FnOnce(&Path) -> Result<T, String>) -> Result<T, String> {
    fs::create_dir_all(home).map_err(|e| format!("Couldn't create {}: {e}", home.display()))?;
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(home.join("auth.json.lock"))
        .map_err(|e| format!("Couldn't open Grok's lock: {e}"))?;
    let deadline = Instant::now() + Duration::from_secs(5);
    while !try_lock_exclusive(&lock) {
        if Instant::now() >= deadline {
            return Err("Grok CLI is saving its sign-in; try again in a moment".into());
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    // Closing the handle (dropping `lock`) releases it.
    f(&home.join("auth.json"))
}

/// An exclusive lock on the file, not waiting for it: `flock` on unix and `LockFileEx` on
/// Windows, what the CLIs' own lock crates use.
#[cfg(unix)]
fn try_lock_exclusive(file: &fs::File) -> bool {
    use std::os::unix::io::AsRawFd;
    // SAFETY: the descriptor belongs to `file`, which outlives the call.
    unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) == 0 }
}

#[cfg(windows)]
fn try_lock_exclusive(file: &fs::File) -> bool {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        LockFileEx, LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY,
    };
    use windows_sys::Win32::System::IO::OVERLAPPED;
    // SAFETY: the handle belongs to `file`, which outlives the call; a zeroed OVERLAPPED
    // locks from offset 0.
    unsafe {
        let mut overlapped: OVERLAPPED = std::mem::zeroed();
        LockFileEx(
            file.as_raw_handle() as _,
            LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
            0,
            u32::MAX,
            u32::MAX,
            &mut overlapped,
        ) != 0
    }
}

/// Puts one issuer's entry in Grok's `auth.json` (None takes it out), leaving the others.
fn write_grok_entry(home: &Path, map_key: &str, entry: Option<&Value>) -> Result<(), String> {
    with_grok_lock(home, |file| {
        if file.exists() && read_json_object(file).is_none() {
            return Err("Grok's auth.json couldn't be read; it was left as it is".into());
        }
        let mut auth = read_json_object(file).unwrap_or_else(|| json!({}));
        let map = auth
            .as_object_mut()
            .ok_or("Grok's auth.json isn't an object")?;
        match entry {
            Some(entry) => {
                map.insert(map_key.to_string(), entry.clone());
            }
            None => {
                map.remove(map_key);
            }
        }
        let text = serde_json::to_string_pretty(&auth).map_err(|e| e.to_string())?;
        write_private(file, text.as_bytes())
    })
}

// ── detecting, saving and installing ────────────────────────────────────────

/// The CLI's sign-in in `home` (a new account's throwaway home).
fn detect_at(cli: AccountCli, home: &Path) -> Option<Detected> {
    match cli {
        AccountCli::Claude => detect_claude(&ClaudeStore::at(home)),
        AccountCli::Codex => read_json_object(&home.join("auth.json")).and_then(parse_codex_auth),
        AccountCli::Grok => read_json_object(&home.join("auth.json")).and_then(parse_grok_auth),
    }
}

/// The account the CLI is signed in with now.
fn detect_live(cli: AccountCli) -> Result<Option<Detected>, String> {
    Ok(match cli {
        AccountCli::Claude => detect_claude(&ClaudeStore::live()?),
        AccountCli::Codex => detect_at(cli, &codex_home()?),
        AccountCli::Grok => detect_at(cli, &grok_home()?),
    })
}

fn slots_dir(cli: AccountCli) -> Result<PathBuf, String> {
    let dir = root_dir()?.join(cli.slug());
    private_dir(&dir)?;
    Ok(dir)
}

fn read_slot(cli: AccountCli, id: &str) -> Option<Slot> {
    let file = slots_dir(cli).ok()?.join(format!("{id}.json"));
    serde_json::from_slice(&fs::read(file).ok()?).ok()
}

/// Every saved account, in the order they were first saved.
fn read_slots(cli: AccountCli) -> Vec<Slot> {
    let Ok(entries) = slots_dir(cli).and_then(|d| fs::read_dir(d).map_err(|e| e.to_string()))
    else {
        return Vec::new();
    };
    let mut slots: Vec<Slot> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("json"))
        // A torn slot file skips that account, not the whole list.
        .filter_map(|p| serde_json::from_slice(&fs::read(p).ok()?).ok())
        .collect();
    slots.sort_by(|a, b| {
        (a.created_at.unwrap_or(a.saved_at), &a.id)
            .cmp(&(b.created_at.unwrap_or(b.saved_at), &b.id))
    });
    slots
}

/// Saves a sign-in as its account's slot (refreshing the tokens it had), returning its id.
fn snapshot(cli: AccountCli, d: &Detected) -> Result<String, String> {
    let id = slot_id_for(cli, &d.account_key);
    let existing = read_slot(cli, &id);
    if cli == AccountCli::Claude
        && existing
            .as_ref()
            .is_some_and(|s| claude_login_is_older(&d.credentials, &s.credentials))
    {
        return Ok(id);
    }
    let slot = Slot {
        id: id.clone(),
        account_key: d.account_key.clone(),
        email: d.email.clone(),
        name: d.name.clone(),
        plan: d.plan.clone(),
        credentials: d.credentials.clone(),
        claude_config: d.claude_config.clone(),
        store_key: d.store_key.clone(),
        saved_at: now_ms(),
        created_at: Some(
            existing
                .map(|s| s.created_at.unwrap_or(s.saved_at))
                .unwrap_or_else(now_ms),
        ),
    };
    let text = serde_json::to_string_pretty(&slot).map_err(|e| e.to_string())?;
    write_private(&slots_dir(cli)?.join(format!("{id}.json")), text.as_bytes())?;
    Ok(id)
}

/// Makes a saved account the CLI's live sign-in.
fn install(cli: AccountCli, slot: &Slot) -> Result<(), String> {
    match cli {
        AccountCli::Claude => {
            let store = ClaudeStore::live()?;
            // A config that exists but can't be read is left alone: writing only the identity
            // would wipe the rest of the user's Claude settings.
            let config = read_json_object(&store.config_file);
            if config.is_none() && store.config_file.exists() {
                return Err(format!(
                    "{} couldn't be read, so it was left as it is",
                    store.config_file.display()
                ));
            }
            let live = store.read_credentials();
            store.write_credentials(&compose_claude_credentials(
                &slot.credentials,
                live.as_ref(),
            ))?;
            let mut config = config.unwrap_or_else(|| json!({}));
            let map = config
                .as_object_mut()
                .ok_or(".claude.json isn't an object")?;
            let saved = slot.claude_config.clone().unwrap_or_default();
            map.insert(
                "oauthAccount".into(),
                saved.get("oauthAccount").cloned().unwrap_or_else(|| {
                    json!({ "accountUuid": slot.account_key, "emailAddress": slot.email, "displayName": slot.name })
                }),
            );
            match saved.get("userID").filter(|v| v.is_string()) {
                Some(uid) => map.insert("userID".into(), uid.clone()),
                None => map.remove("userID"),
            };
            let text = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
            text_io::write_atomic(&store.config_file, text.as_bytes())
                .map_err(|e| format!("Couldn't write {}: {e}", store.config_file.display()))
        }
        AccountCli::Codex => {
            let text =
                serde_json::to_string_pretty(&slot.credentials).map_err(|e| e.to_string())?;
            write_private(&codex_home()?.join("auth.json"), text.as_bytes())
        }
        AccountCli::Grok => {
            let key = slot
                .store_key
                .as_deref()
                .ok_or("That saved Grok account names no issuer")?;
            write_grok_entry(&grok_home()?, key, Some(&slot.credentials))
        }
    }
}

/// Signs the CLI out of its live account, so removing that account sticks.
fn sign_out(cli: AccountCli, live: &Detected) -> Result<(), String> {
    match cli {
        AccountCli::Claude => {
            let store = ClaudeStore::live()?;
            if let Some(mut creds) = store.read_credentials() {
                // Only the account's login goes: MCP servers' OAuth in the same blob stays.
                if let Some(map) = creds.as_object_mut() {
                    map.remove("claudeAiOauth");
                }
                store.write_credentials(&creds)?;
            }
            if let Some(mut config) = read_json_object(&store.config_file) {
                if let Some(map) = config.as_object_mut() {
                    if map.remove("oauthAccount").is_some() {
                        let text =
                            serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
                        text_io::write_atomic(&store.config_file, text.as_bytes())
                            .map_err(|e| e.to_string())?;
                    }
                }
            }
            Ok(())
        }
        AccountCli::Codex => match fs::remove_file(codex_home()?.join("auth.json")) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        },
        AccountCli::Grok => {
            let key = live
                .store_key
                .as_deref()
                .ok_or("Grok's sign-in names no issuer")?;
            write_grok_entry(&grok_home()?, key, None)
        }
    }
}

/// Claude's sign-in is read and replaced while Nyxs' own refreshes wait (see
/// `with_login_refresh_held`); the others have nothing of Nyxs' to wait for.
fn guarded<T>(cli: AccountCli, f: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    match cli {
        AccountCli::Claude => with_login_refresh_held(f),
        _ => f(),
    }
}

fn list_blocking(cli: AccountCli) -> Result<Vec<CliAccountRow>, String> {
    let live_id = match detect_live(cli)? {
        Some(d) => Some(snapshot(cli, &d)?),
        None => None,
    };
    Ok(read_slots(cli)
        .iter()
        .map(|s| s.row(live_id.as_deref() == Some(s.id.as_str())))
        .collect())
}

fn activate_blocking(cli: AccountCli, id: &str) -> Result<Vec<CliAccountRow>, String> {
    if !valid_id(id) {
        return Err("Unknown account".into());
    }
    guarded(cli, || {
        // The live account is saved first with its newest tokens: it may have refreshed them
        // since the list was shown.
        if let Some(d) = detect_live(cli)? {
            snapshot(cli, &d)?;
        }
        let slot = read_slot(cli, id).ok_or("That saved account no longer exists")?;
        install(cli, &slot)
    })?;
    list_blocking(cli)
}

fn forget_blocking(cli: AccountCli, id: &str) -> Result<Vec<CliAccountRow>, String> {
    if !valid_id(id) {
        return Err("Unknown account".into());
    }
    guarded(cli, || {
        if let Some(live) = detect_live(cli)? {
            if slot_id_for(cli, &live.account_key) == id {
                sign_out(cli, &live)?;
            }
        }
        match fs::remove_file(slots_dir(cli)?.join(format!("{id}.json"))) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        }
    })?;
    list_blocking(cli)
}

// ── adding an account ───────────────────────────────────────────────────────

/// Sign-ins under way: their CLI and throwaway home.
static LOGINS: OnceLock<Mutex<HashMap<String, (AccountCli, PathBuf)>>> = OnceLock::new();

fn logins() -> &'static Mutex<HashMap<String, (AccountCli, PathBuf)>> {
    LOGINS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// A throwaway home is deleted once its account is saved; one left by a crash goes later.
fn cleanup_home(cli: AccountCli, home: &Path) {
    let _ = fs::remove_dir_all(home);
    if cli == AccountCli::Claude && cfg!(target_os = "macos") {
        keychain_delete(&claude_keychain_service(Some(home)));
    }
}

fn sweep_stale_homes(root: &Path) {
    let running: Vec<PathBuf> = logins()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .values()
        .map(|(_, home)| home.clone())
        .collect();
    for entry in fs::read_dir(root).into_iter().flatten().flatten() {
        let path = entry.path();
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age > Duration::from_secs(24 * 60 * 60));
        let is_login = entry.file_name().to_string_lossy().starts_with(".login-");
        if is_login && stale && !running.contains(&path) {
            let _ = fs::remove_dir_all(path);
        }
    }
}

fn login_script(cli: AccountCli, bin: &Path, home: &Path) -> String {
    #[cfg(target_os = "windows")]
    return format!(
        "$env:{}='{}'; & '{}' {}",
        cli.home_env(),
        home.to_string_lossy().replace('\'', "''"),
        bin.to_string_lossy().replace('\'', "''"),
        cli.login_args()
    );
    #[cfg(not(target_os = "windows"))]
    return format!(
        "{}='{}' '{}' {}",
        cli.home_env(),
        home.to_string_lossy().replace('\'', "'\\''"),
        bin.to_string_lossy().replace('\'', "'\\''"),
        cli.login_args()
    );
}

/// What a finished sign-in leaves: its account saved, and made the live one when the CLI had
/// none or it is the live account signing in again (its old tokens may be revoked).
fn adopt_new_login(cli: AccountCli, home: &Path) -> Result<Option<CliAccountRow>, String> {
    let Some(d) = detect_at(cli, home) else {
        return Ok(None);
    };
    guarded(cli, || {
        let id = snapshot(cli, &d)?;
        let live = detect_live(cli)?;
        let slot = read_slot(cli, &id).ok_or("The new account couldn't be saved")?;
        let make_live = live.as_ref().is_none_or(|l| l.account_key == d.account_key);
        if make_live {
            install(cli, &slot)?;
        }
        Ok(Some(slot.row(make_live)))
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CliAccountRequest {
    cli: String,
    id: String,
}

/// The CLI's accounts: every one saved, the live one marked. Seeing the live sign-in saves it.
#[tauri::command]
pub async fn cli_accounts_list(cli: String) -> Result<Vec<CliAccountRow>, String> {
    let cli = AccountCli::parse(&cli)?;
    tauri::async_runtime::spawn_blocking(move || list_blocking(cli))
        .await
        .map_err(|e| e.to_string())?
}

/// Switches the CLI to a saved account.
#[tauri::command]
pub async fn cli_accounts_activate(
    request: CliAccountRequest,
) -> Result<Vec<CliAccountRow>, CmdError> {
    let cli = AccountCli::parse(&request.cli)?;
    tauri::async_runtime::spawn_blocking(move || {
        activate_blocking(cli, &request.id)
            .map_err(|e| CmdError::account_change_failed(cli.label(), e))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Removes a saved account; the live one is signed out of the CLI too.
#[tauri::command]
pub async fn cli_accounts_forget(
    request: CliAccountRequest,
) -> Result<Vec<CliAccountRow>, CmdError> {
    let cli = AccountCli::parse(&request.cli)?;
    tauri::async_runtime::spawn_blocking(move || {
        forget_blocking(cli, &request.id)
            .map_err(|e| CmdError::account_change_failed(cli.label(), e))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Opens the CLI's own sign-in in a terminal, pointed at a throwaway home. Returns the id to
/// poll it with.
#[tauri::command(async)]
pub fn cli_accounts_add_start(cli: String) -> Result<String, CmdError> {
    let cli = AccountCli::parse(&cli)?;
    let bin = cli
        .locate()
        .ok_or_else(|| CmdError::cli_not_installed(cli.label()))?;
    let root = root_dir()?;
    private_dir(&root)?;
    sweep_stale_homes(&root);
    // One sign-in per CLI at a time: an older one still open is dropped.
    let mut running = logins().lock().unwrap_or_else(|e| e.into_inner());
    running.retain(|_, (c, home)| {
        let keep = *c != cli;
        if !keep {
            cleanup_home(*c, home);
        }
        keep
    });
    let id = hex(&Sha256::digest(format!(
        "{}:{}:{}",
        cli.slug(),
        now_ms(),
        std::process::id()
    )))[..16]
        .to_string();
    let home = root.join(format!(".login-{id}"));
    private_dir(&home)?;
    if let Err(e) = open_terminal(&login_script(cli, &bin, &home)) {
        cleanup_home(cli, &home);
        return Err(e);
    }
    running.insert(id.clone(), (cli, home));
    Ok(id)
}

/// Whether the sign-in finished: the new account once it's saved, None while it's still going.
#[tauri::command]
pub async fn cli_accounts_add_poll(login_id: String) -> Result<Option<CliAccountRow>, CmdError> {
    let (cli, home) = logins()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&login_id)
        .cloned()
        .ok_or_else(|| "That sign-in is no longer running".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let added = adopt_new_login(cli, &home)
            .map_err(|e| CmdError::account_change_failed(cli.label(), e))?;
        if added.is_some() {
            logins()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&login_id);
            cleanup_home(cli, &home);
        }
        Ok(added)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Stops waiting for a sign-in and deletes its throwaway home.
#[tauri::command]
pub fn cli_accounts_add_cancel(login_id: String) {
    let removed = logins()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&login_id);
    if let Some((cli, home)) = removed {
        cleanup_home(cli, &home);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nyxs-accounts-{name}-{}", now_ms()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    struct Cleanup(PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn jwt(claims: Value) -> String {
        let body = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(claims.to_string());
        format!("e30.{body}.sig")
    }

    #[test]
    fn names_claude_plans() {
        assert_eq!(
            claude_plan(Some("claude_max"), Some("default_claude_max_5x")).as_deref(),
            Some("Max 5×")
        );
        assert_eq!(
            claude_plan(Some("claude_pro"), None).as_deref(),
            Some("Pro")
        );
        assert_eq!(claude_plan(Some("free"), None), None);
    }

    #[test]
    fn keeps_the_machine_s_mcp_logins_on_a_switch() {
        let target = json!({ "claudeAiOauth": { "refreshToken": "b" }, "mcpOAuth": { "old": 1 } });
        let live = json!({ "claudeAiOauth": { "refreshToken": "a" }, "mcpOAuth": { "new": 2 } });
        assert_eq!(
            compose_claude_credentials(&target, Some(&live)),
            json!({ "claudeAiOauth": { "refreshToken": "b" }, "mcpOAuth": { "new": 2 } })
        );
        // Absent live stays absent.
        let bare = json!({ "claudeAiOauth": { "refreshToken": "a" } });
        assert_eq!(
            compose_claude_credentials(&target, Some(&bare)),
            json!({ "claudeAiOauth": { "refreshToken": "b" } })
        );
    }

    #[test]
    fn never_saves_an_older_claude_rotation_over_a_newer_one() {
        let older = json!({ "claudeAiOauth": { "refreshToken": "r1", "expiresAt": 100 } });
        let newer = json!({ "claudeAiOauth": { "refreshToken": "r2", "expiresAt": 200 } });
        assert!(claude_login_is_older(&older, &newer));
        assert!(!claude_login_is_older(&newer, &older));
        assert!(!claude_login_is_older(&older, &older));
    }

    #[test]
    fn reads_codex_and_grok_sign_ins() {
        let auth = json!({ "tokens": { "id_token": jwt(json!({
            "email": "ada@example.com",
            "name": "Ada",
            "https://api.openai.com/auth": { "chatgpt_plan_type": "plus", "chatgpt_account_id": "ws", "chatgpt_user_id": "u1" }
        })) } });
        let codex = parse_codex_auth(auth).unwrap();
        assert_eq!(
            (codex.email.as_str(), codex.account_key.as_str()),
            ("ada@example.com", "u1::ws")
        );
        assert_eq!(codex.plan.as_deref(), Some("Plus"));
        let key = parse_codex_auth(json!({ "OPENAI_API_KEY": "sk-abcd1234" })).unwrap();
        assert_eq!(key.email, "API key ·…1234");

        let grok = parse_grok_auth(json!({
            "legacy": { "key": "k0" },
            "https://auth.x.ai::c": { "key": "k1", "user_id": "u-1", "email": "ada@x.ai", "first_name": "Ada", "last_name": "L" }
        }))
        .unwrap();
        assert_eq!(grok.store_key.as_deref(), Some("https://auth.x.ai::c"));
        assert_eq!(
            (grok.account_key.as_str(), grok.name.as_deref()),
            ("u-1", Some("Ada L"))
        );
    }

    #[test]
    fn finds_a_new_account_in_its_throwaway_home() {
        let dir = temp_dir("home");
        let _cleanup = Cleanup(dir.clone());
        assert!(detect_at(AccountCli::Grok, &dir).is_none());
        write_grok_entry(
            &dir,
            "https://auth.x.ai::c",
            Some(&json!({ "key": "k", "email": "b@x.ai" })),
        )
        .unwrap();
        let found = detect_at(AccountCli::Grok, &dir).unwrap();
        assert_eq!(found.email, "b@x.ai");
        // Taking the entry out leaves the file, empty.
        write_grok_entry(&dir, "https://auth.x.ai::c", None).unwrap();
        assert!(detect_at(AccountCli::Grok, &dir).is_none());

        let claude = dir.join("claude");
        fs::create_dir_all(&claude).unwrap();
        fs::write(
            claude.join(".claude.json"),
            r#"{"oauthAccount":{"emailAddress":"c@d.com","accountUuid":"acc"},"userID":"x"}"#,
        )
        .unwrap();
        // Identity without a login isn't an account yet.
        if !cfg!(target_os = "macos") {
            assert!(detect_at(AccountCli::Claude, &claude).is_none());
            fs::write(
                claude.join(".credentials.json"),
                r#"{"claudeAiOauth":{"refreshToken":"r"}}"#,
            )
            .unwrap();
            let found = detect_at(AccountCli::Claude, &claude).unwrap();
            assert_eq!(
                (found.email.as_str(), found.account_key.as_str()),
                ("c@d.com", "acc")
            );
            assert_eq!(found.claude_config.unwrap()["userID"], json!("x"));
        }
    }

    #[test]
    fn accepts_only_slot_ids() {
        assert!(valid_id(&slot_id_for(AccountCli::Codex, "k")));
        assert!(!valid_id("../../etc/passwd"));
        assert!(!valid_id("ABCDEF0123456789"));
    }
}
