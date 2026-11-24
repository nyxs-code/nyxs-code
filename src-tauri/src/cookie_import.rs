//! "Import cookies" in the built-in browser, as Claude Code Desktop has it: the cookies of
//! another browser on this computer go into the browser's own cookie profile, so the sites
//! chosen open signed in. Firefox keeps them readable in SQLite on every system. Chrome, Edge
//! and Brave encrypt them: on macOS with a key in the Keychain (the system asks the user first);
//! on Windows they are bound to the browser itself and can't be read, so there only Firefox is
//! offered, as in Claude.

use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use tauri::AppHandle;

/// A browser profile whose cookies can be imported, as the dialog lists it.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CookieSource {
    /// What the other commands take back to name it.
    id: String,
    /// "firefox", "chrome", "edge" or "brave".
    browser: String,
    /// The profile's name in that browser; "" when it has only one.
    profile: String,
    /// False where its cookies can't be read here (Chromium browsers on Windows).
    supported: bool,
}

/// A site with cookies in the source, grouped by its registrable domain.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CookieSite {
    site: String,
    cookies: usize,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    sites: usize,
    cookies: usize,
    /// Cookies the browser's store refused (malformed, or a secure-only one for http).
    failed: usize,
}

#[derive(Clone, Debug, PartialEq)]
enum Kind {
    Firefox,
    /// Chromium on macOS: its Keychain item (service, account).
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    Chromium {
        service: &'static str,
        account: &'static str,
    },
    /// Installed, but its cookies can't be read on this system.
    Unreadable,
}

#[derive(Clone, Debug)]
struct Located {
    source: CookieSource,
    kind: Kind,
    db: PathBuf,
}

/// One cookie as a browser stored it, in the terms the webview's store takes.
#[derive(Clone, Debug, PartialEq)]
struct RawCookie {
    /// As stored: a leading dot for a cookie of the whole domain, none for one host only.
    host: String,
    name: String,
    value: String,
    path: String,
    /// Unix seconds; None for a session cookie.
    expires: Option<i64>,
    secure: bool,
    http_only: bool,
    same_site: Option<cookie::SameSite>,
}

/// Second-level suffixes under which a site is three labels long (example.co.uk).
const TWO_LABEL_SUFFIXES: &[&str] = &[
    "co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au", "co.nz", "co.jp", "ne.jp",
    "or.jp", "com.br", "com.mx", "com.ar", "com.co", "com.es", "co.in", "co.kr", "com.cn",
    "com.tr", "co.za", "com.sg", "com.hk", "com.tw", "com.pe", "com.uy", "com.ve",
];

/// The site a cookie's host belongs to: its registrable domain, near enough.
fn site_of(host: &str) -> String {
    let host = host.trim_start_matches('.').to_ascii_lowercase();
    if host.parse::<std::net::IpAddr>().is_ok() {
        return host;
    }
    let labels: Vec<&str> = host.split('.').filter(|l| !l.is_empty()).collect();
    if labels.len() <= 2 {
        return labels.join(".");
    }
    let last_two = labels[labels.len() - 2..].join(".");
    let keep = if TWO_LABEL_SUFFIXES.contains(&last_two.as_str()) {
        3
    } else {
        2
    };
    labels[labels.len() - keep..].join(".")
}

// ---- Finding the browsers ----

fn firefox_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();
    #[cfg(target_os = "windows")]
    if let Some(d) = dirs::data_dir() {
        roots.push(d.join("Mozilla").join("Firefox"));
    }
    #[cfg(target_os = "macos")]
    if let Some(d) = dirs::data_dir() {
        roots.push(d.join("Firefox"));
    }
    #[cfg(target_os = "linux")]
    if let Some(h) = dirs::home_dir() {
        roots.push(h.join(".mozilla").join("firefox"));
        roots.push(
            h.join("snap")
                .join("firefox")
                .join("common")
                .join(".mozilla")
                .join("firefox"),
        );
    }
    roots
}

/// The profiles `profiles.ini` names under `root`: their name and folder.
fn firefox_profiles(root: &Path) -> Vec<(String, PathBuf)> {
    let Ok(ini) = std::fs::read_to_string(root.join("profiles.ini")) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let (mut in_profile, mut name, mut path, mut relative) =
        (false, String::new(), String::new(), true);
    let flush =
        |name: &mut String, path: &mut String, relative: bool, out: &mut Vec<(String, PathBuf)>| {
            if !path.is_empty() {
                let dir = if relative {
                    root.join(&*path)
                } else {
                    PathBuf::from(&*path)
                };
                out.push((std::mem::take(name), dir));
            }
            path.clear();
            name.clear();
        };
    for line in ini.lines().map(str::trim) {
        if line.starts_with('[') {
            if in_profile {
                flush(&mut name, &mut path, relative, &mut out);
            }
            in_profile = line.to_ascii_lowercase().starts_with("[profile");
            relative = true;
        } else if in_profile {
            if let Some((k, v)) = line.split_once('=') {
                match k.trim() {
                    "Name" => name = v.trim().to_string(),
                    "Path" => path = v.trim().replace('\\', "/"),
                    "IsRelative" => relative = v.trim() != "0",
                    _ => {}
                }
            }
        }
    }
    if in_profile {
        flush(&mut name, &mut path, relative, &mut out);
    }
    out
}

#[cfg(target_os = "macos")]
const CHROMIUM: &[(&str, &[&str], &str, &str)] = &[
    (
        "chrome",
        &["Google", "Chrome"],
        "Chrome Safe Storage",
        "Chrome",
    ),
    (
        "edge",
        &["Microsoft Edge"],
        "Microsoft Edge Safe Storage",
        "Microsoft Edge",
    ),
    (
        "brave",
        &["BraveSoftware", "Brave-Browser"],
        "Brave Safe Storage",
        "Brave",
    ),
];

/// A Chromium browser's profiles that keep cookies: (shown name, cookie database).
#[cfg(target_os = "macos")]
fn chromium_profiles(base: &Path) -> Vec<(String, PathBuf)> {
    let names: serde_json::Value = std::fs::read_to_string(base.join("Local State"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let Ok(entries) = std::fs::read_dir(base) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for e in entries.flatten() {
        let dir = e.file_name().to_string_lossy().to_string();
        if dir != "Default" && !dir.starts_with("Profile ") {
            continue;
        }
        let db = [
            e.path().join("Cookies"),
            e.path().join("Network").join("Cookies"),
        ]
        .into_iter()
        .find(|p| p.is_file());
        if let Some(db) = db {
            let name = names["profile"]["info_cache"][&dir]["name"]
                .as_str()
                .unwrap_or(&dir)
                .to_string();
            out.push((name, db));
        }
    }
    out
}

fn modified(p: &Path) -> std::time::SystemTime {
    std::fs::metadata(p)
        .and_then(|m| m.modified())
        .unwrap_or(std::time::UNIX_EPOCH)
}

fn locate() -> Vec<Located> {
    let mut found: Vec<Located> = Vec::new();
    let mut ff: Vec<(String, PathBuf)> = firefox_roots()
        .iter()
        .flat_map(|r| firefox_profiles(r))
        .map(|(name, dir)| (name, dir.join("cookies.sqlite")))
        .filter(|(_, db)| db.is_file())
        .collect();
    // The profile used last first: its cookies are the ones the user means.
    ff.sort_by_key(|(_, db)| std::cmp::Reverse(modified(db)));
    let single = ff.len() == 1;
    for (name, db) in ff {
        found.push(Located {
            source: CookieSource {
                id: format!("firefox:{}", db.to_string_lossy()),
                browser: "firefox".into(),
                profile: if single { String::new() } else { name },
                supported: true,
            },
            kind: Kind::Firefox,
            db,
        });
    }
    #[cfg(target_os = "macos")]
    if let Some(support) = dirs::data_dir() {
        for (browser, parts, service, account) in CHROMIUM {
            let base = parts.iter().fold(support.clone(), |p, part| p.join(part));
            let mut profiles = chromium_profiles(&base);
            profiles.sort_by_key(|(_, db)| std::cmp::Reverse(modified(db)));
            let single = profiles.len() == 1;
            for (name, db) in profiles {
                found.push(Located {
                    source: CookieSource {
                        id: format!("{browser}:{}", db.to_string_lossy()),
                        browser: (*browser).into(),
                        profile: if single { String::new() } else { name },
                        supported: true,
                    },
                    kind: Kind::Chromium { service, account },
                    db,
                });
            }
        }
    }
    #[cfg(target_os = "windows")]
    if let Some(local) = dirs::data_local_dir() {
        for (browser, parts) in [
            ("chrome", &["Google", "Chrome", "User Data"][..]),
            ("edge", &["Microsoft", "Edge", "User Data"][..]),
            (
                "brave",
                &["BraveSoftware", "Brave-Browser", "User Data"][..],
            ),
        ] {
            let dir = parts.iter().fold(local.clone(), |p, part| p.join(part));
            if dir.is_dir() {
                found.push(Located {
                    source: CookieSource {
                        id: format!("{browser}:unreadable"),
                        browser: browser.into(),
                        profile: String::new(),
                        supported: false,
                    },
                    kind: Kind::Unreadable,
                    db: dir,
                });
            }
        }
    }
    found
}

/// The source `id` names, among the ones found now: an id never opens a path it doesn't list.
fn find_source(id: &str) -> Result<Located, String> {
    locate()
        .into_iter()
        .find(|l| l.source.id == id && l.source.supported)
        .ok_or_else(|| "That browser profile is no longer there.".to_string())
}

// ---- Reading the cookies ----

/// A copy of a database the browser may have open (and its write-ahead log), removed on drop.
struct DbCopy {
    dir: PathBuf,
    db: PathBuf,
}

impl DbCopy {
    fn of(db: &Path) -> Result<Self, String> {
        static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "nyxs-cookie-import-{}-{}",
            std::process::id(),
            N.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let copy = dir.join("cookies.db");
        std::fs::copy(db, &copy)
            .map_err(|e| format!("Couldn't read the browser's cookies: {e}"))?;
        for ext in ["-wal", "-shm"] {
            let side = PathBuf::from(format!("{}{ext}", db.to_string_lossy()));
            if side.is_file() {
                let _ = std::fs::copy(&side, dir.join(format!("cookies.db{ext}")));
            }
        }
        Ok(DbCopy { dir, db: copy })
    }

    fn open(&self) -> Result<Connection, String> {
        // Read-write on the copy, so SQLite folds the copied log in.
        Connection::open_with_flags(
            &self.db,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|e| format!("Couldn't open the browser's cookies: {e}"))
    }
}

impl Drop for DbCopy {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn firefox_same_site(v: i64) -> Option<cookie::SameSite> {
    match v {
        0 => Some(cookie::SameSite::None),
        1 => Some(cookie::SameSite::Lax),
        2 => Some(cookie::SameSite::Strict),
        _ => None,
    }
}

/// Firefox's expiry: seconds, or milliseconds in newer versions; 0 or less for none.
fn firefox_expiry(v: i64) -> Option<i64> {
    if v <= 0 {
        None
    } else if v > 100_000_000_000 {
        Some(v / 1000)
    } else {
        Some(v)
    }
}

fn read_firefox(db: &Path) -> Result<Vec<RawCookie>, String> {
    let copy = DbCopy::of(db)?;
    let conn = copy.open()?;
    // Only the default container: a container tab's cookies belong to that container.
    let mut stmt = conn
        .prepare(
            "SELECT host, name, value, path, expiry, isSecure, isHttpOnly, sameSite FROM moz_cookies \
             WHERE originAttributes = ''",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(RawCookie {
                host: r.get(0)?,
                name: r.get(1)?,
                value: r.get(2)?,
                path: r.get::<_, Option<String>>(3)?.unwrap_or_else(|| "/".into()),
                expires: firefox_expiry(r.get(4)?),
                secure: r.get::<_, i64>(5)? != 0,
                http_only: r.get::<_, i64>(6)? != 0,
                same_site: firefox_same_site(r.get(7)?),
            })
        })
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(Result::ok).collect())
}

/// Chromium's time: microseconds since 1601; 0 for a session cookie.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn chromium_expiry(v: i64) -> Option<i64> {
    (v > 0).then(|| v / 1_000_000 - 11_644_473_600)
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn chromium_same_site(v: i64) -> Option<cookie::SameSite> {
    match v {
        0 => Some(cookie::SameSite::None),
        1 => Some(cookie::SameSite::Lax),
        2 => Some(cookie::SameSite::Strict),
        _ => None,
    }
}

/// A Chromium cookie value, decrypted with the key from the browser's Keychain item: "v10",
/// then AES-128-CBC (IV of spaces). From database version 24 the value starts with the
/// SHA-256 of its host, which isn't part of it.
#[cfg(target_os = "macos")]
fn chromium_decrypt(key: &[u8; 16], encrypted: &[u8], host_prefix: bool) -> Option<String> {
    use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, KeyIvInit};
    let body = encrypted.strip_prefix(b"v10")?;
    let mut buf = body.to_vec();
    let plain = cbc::Decryptor::<aes::Aes128>::new(key.into(), &[b' '; 16].into())
        .decrypt_padded_mut::<Pkcs7>(&mut buf)
        .ok()?;
    let plain = if host_prefix && plain.len() >= 32 {
        &plain[32..]
    } else {
        plain
    };
    String::from_utf8(plain.to_vec()).ok()
}

/// The key a Chromium browser encrypts cookies with: its Keychain password through PBKDF2.
/// Reading the password makes macOS ask the user.
#[cfg(target_os = "macos")]
fn chromium_key(service: &str, account: &str) -> Result<[u8; 16], String> {
    let out = std::process::Command::new("security")
        .args(["find-generic-password", "-w", "-s", service, "-a", account])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err("keychain".into());
    }
    let password = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Ok(chromium_key_from(password.as_bytes()))
}

#[cfg(target_os = "macos")]
fn chromium_key_from(password: &[u8]) -> [u8; 16] {
    let mut key = [0u8; 16];
    pbkdf2::pbkdf2_hmac::<sha1::Sha1>(password, b"saltysalt", 1003, &mut key);
    key
}

/// `decrypt`: false to read only where the cookies are (listing the sites needs no key).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn read_chromium(db: &Path, key: Option<&[u8; 16]>) -> Result<Vec<RawCookie>, String> {
    let copy = DbCopy::of(db)?;
    let conn = copy.open()?;
    let version: i64 = conn
        .query_row("SELECT value FROM meta WHERE key = 'version'", [], |r| {
            r.get::<_, String>(0)
        })
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let mut stmt = conn
        .prepare(
            "SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite FROM cookies",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, Vec<u8>>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, i64>(5)?,
                r.get::<_, i64>(6)? != 0,
                r.get::<_, i64>(7)? != 0,
                r.get::<_, i64>(8)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for (host, name, value, encrypted, path, expires, secure, http_only, same_site) in
        rows.flatten()
    {
        let value = if !value.is_empty() || encrypted.is_empty() {
            value
        } else {
            match key {
                #[cfg(target_os = "macos")]
                Some(k) => match chromium_decrypt(k, &encrypted, version >= 24) {
                    Some(v) => v,
                    None => continue,
                },
                _ => {
                    let _ = (version, key);
                    String::new()
                }
            }
        };
        out.push(RawCookie {
            host,
            name,
            value,
            path,
            expires: chromium_expiry(expires),
            secure,
            http_only,
            same_site: chromium_same_site(same_site),
        });
    }
    Ok(out)
}

fn read(source: &Located, decrypt: bool) -> Result<Vec<RawCookie>, String> {
    match &source.kind {
        Kind::Firefox => read_firefox(&source.db),
        #[cfg(target_os = "macos")]
        Kind::Chromium { service, account } => {
            if decrypt {
                let key = chromium_key(service, account)?;
                read_chromium(&source.db, Some(&key))
            } else {
                read_chromium(&source.db, None)
            }
        }
        #[cfg(not(target_os = "macos"))]
        Kind::Chromium { .. } => {
            let _ = decrypt;
            read_chromium(&source.db, None)
        }
        Kind::Unreadable => Err("This browser's cookies can't be read on this computer.".into()),
    }
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// The sites with live cookies, the ones with most cookies first.
fn sites_of(cookies: &[RawCookie]) -> Vec<CookieSite> {
    let now = now_secs();
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for c in cookies.iter().filter(|c| c.expires.is_none_or(|e| e > now)) {
        *counts.entry(site_of(&c.host)).or_default() += 1;
    }
    let mut sites: Vec<CookieSite> = counts
        .into_iter()
        .filter(|(site, _)| !site.is_empty())
        .map(|(site, cookies)| CookieSite { site, cookies })
        .collect();
    sites.sort_by(|a, b| b.cookies.cmp(&a.cookies).then(a.site.cmp(&b.site)));
    sites
}

/// The cookie as the webview's store takes it. `keep`: false makes it a session cookie, gone
/// when Nyxs quits. The `cookie` crate drops one leading dot from the domain, so a cookie of a
/// whole domain is given two, and the store gets ".example.com".
fn to_cookie(c: &RawCookie, keep: bool) -> cookie::Cookie<'static> {
    let mut out = cookie::Cookie::new(c.name.clone(), c.value.clone());
    out.set_domain(if c.host.starts_with('.') {
        format!(".{}", c.host)
    } else {
        c.host.clone()
    });
    out.set_path(if c.path.is_empty() {
        "/".to_string()
    } else {
        c.path.clone()
    });
    out.set_secure(c.secure);
    out.set_http_only(c.http_only);
    if let Some(s) = c.same_site {
        out.set_same_site(s);
    }
    if keep {
        if let Some(t) = c
            .expires
            .and_then(|e| cookie::time::OffsetDateTime::from_unix_timestamp(e).ok())
        {
            out.set_expires(t);
        }
    }
    out
}

#[tauri::command]
pub fn browser_cookie_sources() -> Vec<CookieSource> {
    locate().into_iter().map(|l| l.source).collect()
}

#[tauri::command]
pub async fn browser_cookie_sites(source: String) -> Result<Vec<CookieSite>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let located = find_source(&source)?;
        Ok(sites_of(&read(&located, false)?))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Imports the cookies of `sites` from `source` into the built-in browser's `profile`.
#[tauri::command]
pub async fn browser_cookie_import(
    app: AppHandle,
    source: String,
    sites: Vec<String>,
    keep: bool,
    profile: Option<String>,
) -> Result<ImportResult, String> {
    let wanted: HashSet<String> = sites.into_iter().collect();
    let cookies = tauri::async_runtime::spawn_blocking(move || {
        let located = find_source(&source)?;
        let now = now_secs();
        Ok::<_, String>(
            read(&located, true)?
                .into_iter()
                .filter(|c| c.expires.is_none_or(|e| e > now) && wanted.contains(&site_of(&c.host)))
                .collect::<Vec<_>>(),
        )
    })
    .await
    .map_err(|e| e.to_string())??;
    let store = crate::preview_webview::cookie_keeper(&app, profile)?;
    let mut done_sites = HashSet::new();
    let (mut imported, mut failed) = (0, 0);
    for c in &cookies {
        match store.set_cookie(to_cookie(c, keep)) {
            Ok(()) => {
                imported += 1;
                done_sites.insert(site_of(&c.host));
            }
            Err(e) => {
                failed += 1;
                log::warn!("cookie import: {} refused: {e}", site_of(&c.host));
            }
        }
    }
    log::info!(
        "cookie import: {imported} cookies for {} sites ({failed} refused)",
        done_sites.len()
    );
    Ok(ImportResult {
        sites: done_sites.len(),
        cookies: imported,
        failed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_site_is_its_registrable_domain() {
        assert_eq!(site_of(".github.com"), "github.com");
        assert_eq!(site_of("gist.github.com"), "github.com");
        assert_eq!(site_of("www.bbc.co.uk"), "bbc.co.uk");
        assert_eq!(site_of("localhost"), "localhost");
        assert_eq!(site_of("127.0.0.1"), "127.0.0.1");
    }

    #[test]
    fn firefox_profiles_come_from_profiles_ini() {
        let root = std::env::temp_dir().join(format!("nyxs-ff-ini-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join("profiles.ini"),
            "[Install4F96D1932A9F858E]\nDefault=Profiles/abc.default-release\n\n[Profile1]\nName=default\nIsRelative=1\nPath=Profiles/xyz.default\n\n[Profile0]\nName=default-release\nIsRelative=1\nPath=Profiles/abc.default-release\nDefault=1\n\n[General]\nVersion=2\n",
        )
        .unwrap();
        let profiles = firefox_profiles(&root);
        assert_eq!(
            profiles,
            vec![
                ("default".to_string(), root.join("Profiles/xyz.default")),
                (
                    "default-release".to_string(),
                    root.join("Profiles/abc.default-release")
                ),
            ]
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn firefox_cookies_are_read_from_its_database() {
        let dir = std::env::temp_dir().join(format!("nyxs-ff-db-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("cookies.sqlite");
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch(
            "CREATE TABLE moz_cookies (id INTEGER PRIMARY KEY, originAttributes TEXT NOT NULL DEFAULT '', name TEXT, value TEXT, host TEXT, path TEXT, expiry INTEGER, lastAccessed INTEGER, creationTime INTEGER, isSecure INTEGER, isHttpOnly INTEGER, inBrowserElement INTEGER DEFAULT 0, sameSite INTEGER DEFAULT 0, rawSameSite INTEGER DEFAULT 0, schemeMap INTEGER DEFAULT 0);
             INSERT INTO moz_cookies (originAttributes, name, value, host, path, expiry, isSecure, isHttpOnly, sameSite) VALUES
               ('', 'user_session', 'abc', '.github.com', '/', 4102444800, 1, 1, 1),
               ('', 'theme', 'dark', 'docs.github.com', '/docs', 4102444800000, 0, 0, 0),
               ('^userContextId=2', 'work', 'x', '.github.com', '/', 4102444800, 1, 1, 1),
               ('', 'old', 'y', 'vercel.com', '/', 1000, 0, 0, 0);",
        )
        .unwrap();
        drop(conn);
        let cookies = read_firefox(&db).unwrap();
        assert_eq!(cookies.len(), 3, "the container tab's cookie is left out");
        assert_eq!(cookies[0].host, ".github.com");
        assert_eq!(cookies[0].expires, Some(4102444800));
        assert_eq!(
            cookies[1].expires,
            Some(4102444800),
            "milliseconds read as seconds"
        );
        assert_eq!(cookies[0].same_site, Some(cookie::SameSite::Lax));
        // The expired one isn't offered.
        assert_eq!(
            sites_of(&cookies),
            vec![CookieSite {
                site: "github.com".into(),
                cookies: 2
            }]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_domain_cookie_reaches_the_store_with_its_leading_dot() {
        let domain = RawCookie {
            host: ".github.com".into(),
            name: "n".into(),
            value: "v".into(),
            path: "/".into(),
            expires: Some(4102444800),
            secure: true,
            http_only: true,
            same_site: Some(cookie::SameSite::Lax),
        };
        let kept = to_cookie(&domain, true);
        assert_eq!(kept.domain(), Some(".github.com"));
        assert_eq!(
            kept.expires_datetime().map(|t| t.unix_timestamp()),
            Some(4102444800)
        );
        assert!(
            to_cookie(&domain, false).expires().is_none(),
            "not kept: a session cookie"
        );
        let host_only = RawCookie {
            host: "docs.github.com".into(),
            ..domain
        };
        assert_eq!(
            to_cookie(&host_only, true).domain(),
            Some("docs.github.com")
        );
    }

    #[test]
    fn chromium_times_count_from_1601() {
        assert_eq!(chromium_expiry(0), None);
        assert_eq!(
            chromium_expiry(13_400_000_000_000_000),
            Some(13_400_000_000 - 11_644_473_600)
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn chromium_values_decrypt_with_the_keychain_key() {
        use aes::cipher::{block_padding::Pkcs7, BlockEncryptMut, KeyIvInit};
        let key = chromium_key_from(b"peanuts");
        let plain = [vec![0u8; 32], b"secret".to_vec()].concat();
        let mut buf = vec![0u8; plain.len() + 16];
        let enc = cbc::Encryptor::<aes::Aes128>::new(&key.into(), &[b' '; 16].into())
            .encrypt_padded_b2b_mut::<Pkcs7>(&plain, &mut buf)
            .unwrap()
            .to_vec();
        let stored = [b"v10".to_vec(), enc].concat();
        assert_eq!(
            chromium_decrypt(&key, &stored, true).as_deref(),
            Some("secret")
        );
    }
}
