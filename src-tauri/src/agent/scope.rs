use super::*;
use std::path::Component;

#[derive(Default)]
struct PathScope {
    roots: Vec<PathBuf>,
    extra: HashMap<PathBuf, usize>,
}

impl PathScope {
    fn all(&self) -> impl Iterator<Item = &PathBuf> {
        self.roots.iter().chain(self.extra.keys())
    }
}

static SCOPES: OnceLock<Mutex<HashMap<String, PathScope>>> = OnceLock::new();
static SHARED_ROOTS: OnceLock<Mutex<Vec<PathBuf>>> = OnceLock::new();
static READ_ONLY_ROOTS: OnceLock<Mutex<Vec<PathBuf>>> = OnceLock::new();

fn scopes() -> &'static Mutex<HashMap<String, PathScope>> {
    SCOPES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn shared_roots() -> &'static Mutex<Vec<PathBuf>> {
    SHARED_ROOTS.get_or_init(|| Mutex::new(default_shared_roots()))
}

fn read_only_roots() -> &'static Mutex<Vec<PathBuf>> {
    READ_ONLY_ROOTS.get_or_init(|| Mutex::new(Vec::new()))
}

pub(crate) fn add_read_only_root(path: PathBuf) {
    let mut roots = read_only_roots().lock().unwrap_or_else(|e| e.into_inner());
    if !roots.contains(&path) {
        roots.push(path);
    }
}

fn default_shared_roots() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(home) = home_dir() {
        out.push(home.join(".nyxs"));
        // `dev-mods`: the mods Claude Code writes in a session, which Nyxs loads (src/lib/mods/).
        for sub in ["skills", "commands", "agents", "dev-mods"] {
            out.push(home.join(".claude").join(sub));
        }
    }
    #[cfg(unix)]
    for marker in ["/.dockerenv", "/run/.containerenv", "/proc/1/cgroup"] {
        out.push(PathBuf::from(marker));
    }
    out
}

fn absolute_root(raw: &str) -> Option<PathBuf> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let p = PathBuf::from(trimmed);
    if !p.is_absolute() || p.components().any(|c| matches!(c, Component::ParentDir)) {
        return None;
    }
    Some(p)
}

fn add_shared_root(path: PathBuf) {
    let mut roots = shared_roots().lock().unwrap_or_else(|e| e.into_inner());
    if !roots.contains(&path) {
        roots.push(path);
    }
}

pub(crate) fn init_path_roots(app: &AppHandle) {
    let resolver = app.path();
    for dir in [
        resolver.app_data_dir(),
        resolver.app_local_data_dir(),
        resolver.app_config_dir(),
        resolver.app_cache_dir(),
    ]
    .into_iter()
    .flatten()
    {
        add_shared_root(dir);
    }
    if let Ok(cache) = resolver.app_cache_dir() {
        super::output_log::init_output_logs(cache);
    }
}

/// Where a path really is, through `..` and symlinks, or `None` behind a broken symlink. A path
/// that doesn't exist yet resolves through the part of it that does.
pub(crate) fn resolve_path(p: &Path) -> Option<PathBuf> {
    let mut p = p.to_path_buf();
    for _ in 0..40 {
        match fs::symlink_metadata(&p) {
            Ok(m) if m.file_type().is_symlink() => {
                let link = fs::read_link(&p).ok()?;
                // A relative link points from its own folder.
                p = match p.parent() {
                    Some(dir) => dir.join(link),
                    None => link,
                };
                fs::symlink_metadata(&p).ok()?;
            }
            Ok(_) => return Some(resolve_existing(&p)),
            Err(_) => return resolve_missing(&p),
        }
    }
    None
}

/// On Windows, canonicalizing a file just as another write renames a new copy over it fails,
/// or gives the old copy's path under `\$Extend\$Deleted`: the folder, which no write replaces,
/// is canonicalized instead, and the file's own answer is only kept when it agrees with it (it
/// still turns a short 8.3 name or another letter case into the name on disk).
fn resolve_existing(p: &Path) -> PathBuf {
    let whole = || fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    let (Some(parent), Some(name)) = (p.parent(), p.file_name()) else {
        return whole();
    };
    let Ok(dir) = fs::canonicalize(parent) else {
        return whole();
    };
    match fs::canonicalize(p) {
        Ok(c) if c.parent() == Some(dir.as_path()) => c,
        _ => dir.join(name),
    }
}

fn resolve_missing(p: &Path) -> Option<PathBuf> {
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    let mut cur = p;
    loop {
        if fs::symlink_metadata(cur).is_ok() {
            return None;
        }
        tail.push(cur.file_name()?.to_os_string());
        cur = cur.parent()?;
        if let Ok(mut out) = fs::canonicalize(cur) {
            for seg in tail.iter().rev() {
                out.push(seg);
            }
            return Some(out);
        }
    }
}

fn roots_for(scope: Option<&str>) -> Result<Vec<PathBuf>, String> {
    let raw: Vec<PathBuf> = {
        let registry = scopes().lock().unwrap_or_else(|e| e.into_inner());
        match scope {
            Some(id) => {
                let entry = registry
                    .get(id)
                    .filter(|s| s.all().next().is_some())
                    .ok_or_else(|| {
                        format!("Access denied: the path scope \"{id}\" isn't registered.")
                    })?;
                entry.all().cloned().collect()
            }
            None => {
                let shared = shared_roots().lock().unwrap_or_else(|e| e.into_inner());
                shared
                    .iter()
                    .cloned()
                    .chain(registry.values().flat_map(|s| s.all().cloned()))
                    .collect()
            }
        }
    };
    Ok(raw.iter().filter_map(|r| resolve_path(r)).collect())
}

/// The network share or device a Windows path is on (`\\server\share`, `\\?\UNC\…`, `\\.\…`),
/// lowercased, or `None` for a drive path. Plain and verbatim UNC forms give the same key.
fn share_of(p: &Path) -> Option<String> {
    use std::path::Prefix;
    let Some(Component::Prefix(prefix)) = p.components().next() else {
        return None;
    };
    let key = match prefix.kind() {
        Prefix::Disk(_) | Prefix::VerbatimDisk(_) => return None,
        Prefix::UNC(server, share) | Prefix::VerbatimUNC(server, share) => {
            format!(
                r"\\{}\{}",
                server.to_string_lossy(),
                share.to_string_lossy()
            )
        }
        _ => prefix.as_os_str().to_string_lossy().into_owned(),
    };
    Some(key.to_lowercase())
}

/// Whether some allowed folder sits on that share, decided from the folders' names alone.
/// Resolving the path first would already reach the server, and Windows answers an SMB server
/// with the user's NTLM hash: a path in a model's reply must not get that far.
fn share_is_allowed(share: &str, scope: Option<&str>, allow_read_only: bool) -> bool {
    let on_share = |roots: &[PathBuf]| roots.iter().any(|r| share_of(r).as_deref() == Some(share));
    if allow_read_only {
        let read_only = read_only_roots().lock().unwrap_or_else(|e| e.into_inner());
        if on_share(&read_only) {
            return true;
        }
    }
    let registry = scopes().lock().unwrap_or_else(|e| e.into_inner());
    match scope {
        Some(id) => registry
            .get(id)
            .is_some_and(|s| on_share(&s.all().cloned().collect::<Vec<_>>())),
        None => {
            let shared = shared_roots().lock().unwrap_or_else(|e| e.into_inner());
            on_share(&shared)
                || registry
                    .values()
                    .any(|s| on_share(&s.all().cloned().collect::<Vec<_>>()))
        }
    }
}

pub(crate) fn confine(path: &str, scope: Option<&str>) -> Result<(), String> {
    confine_to(path, scope, true)
}

fn confine_to(path: &str, scope: Option<&str>, allow_read_only: bool) -> Result<(), String> {
    if crate::remote::is_remote(path) {
        return confine_remote(path, scope);
    }
    let target = Path::new(path);
    if !target.is_absolute() {
        return Err(format!("Access denied: \"{path}\" isn't an absolute path."));
    }
    if target
        .components()
        .any(|c| matches!(c, Component::ParentDir))
    {
        return Err(format!("Access denied: \"{path}\" contains '..'."));
    }
    if let Some(share) = share_of(target) {
        if !share_is_allowed(&share, scope, allow_read_only) {
            return Err(format!(
                "Access denied: \"{path}\" is on a network share or device outside the project."
            ));
        }
    }
    let resolved = resolve_path(target)
        .ok_or_else(|| format!("Access denied: couldn't resolve \"{path}\" (broken symlink?)."))?;
    let inside = |roots: &[PathBuf]| {
        roots
            .iter()
            .any(|r| resolved == *r || resolved.starts_with(r))
    };
    if allow_read_only {
        let read_only: Vec<PathBuf> = read_only_roots()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .filter_map(|r| resolve_path(r))
            .collect();
        if inside(&read_only) {
            return Ok(());
        }
    }
    let roots = roots_for(scope)?;
    if inside(&roots) {
        Ok(())
    } else {
        Err(format!(
            "Access denied: \"{path}\" is outside the project and the allowed folders \
             (including when reached through a symlink)."
        ))
    }
}

pub(crate) fn is_protected_config(path: &Path) -> bool {
    let lower =
        |p: Option<&std::ffi::OsStr>| p.and_then(|n| n.to_str()).map(str::to_ascii_lowercase);
    let name = lower(path.file_name());
    let parent = lower(path.parent().and_then(Path::file_name));
    matches!(
        name.as_deref(),
        Some("settings.json" | "settings.local.json")
    ) && parent.as_deref() == Some(".nyxs")
}

pub(crate) fn confine_write(
    path: &str,
    scope: Option<&str>,
    allow_config: bool,
) -> Result<(), String> {
    confine_to(path, scope, false)?;
    if scope.is_none() || allow_config {
        return Ok(());
    }
    if let Some(r) = crate::remote::parse(path) {
        if is_protected_config(Path::new(&r.path)) {
            return Err(format!(
                "Access denied: \"{path}\" is the project configuration (.nyxs/settings*.json)                  and can only be modified with the user's explicit permission."
            ));
        }
        return Ok(());
    }
    let target = Path::new(path);
    let resolved = resolve_path(target);
    if is_protected_config(target)
        || resolved
            .as_deref()
            .map(is_protected_config)
            .unwrap_or(false)
    {
        return Err(format!(
            "Access denied: \"{path}\" is the project configuration (.nyxs/settings*.json) \
             and can only be modified with the user's explicit permission."
        ));
    }
    Ok(())
}

#[derive(Default)]
struct RemoteScope {
    roots: Vec<crate::remote::RemotePath>,
    extra: HashMap<String, usize>,
}

/// The `ssh://` roots of each scope: a remote project is checked by path, on its own machine.
fn remote_scopes() -> &'static Mutex<HashMap<String, RemoteScope>> {
    static R: OnceLock<Mutex<HashMap<String, RemoteScope>>> = OnceLock::new();
    R.get_or_init(Default::default)
}

/// Resolves paths on a machine: each one's real place with symlinks followed (`None` for a
/// broken link), all in one call to its helper.
type RemoteResolver<'a> = dyn Fn(&str, &[String]) -> Result<Vec<Option<String>>, String> + 'a;

fn helper_resolve(host: &str, paths: &[String]) -> Result<Vec<Option<String>>, String> {
    let v = crate::remote::call(host, "resolve", serde_json::json!({ "paths": paths }))
        .map_err(|e| e.message)?;
    serde_json::from_value(v).map_err(|e| e.to_string())
}

/// How long a remote path's resolution is reused. Every file call checks its path, so without
/// this each one would wait for an extra trip to the machine; a link made after the check is
/// only seen once its entry expires.
const REMOTE_RESOLVE_TTL: Duration = Duration::from_secs(30);

type ResolveCache = HashMap<(String, String), (Instant, Option<String>)>;

fn resolve_cache() -> &'static Mutex<ResolveCache> {
    static C: OnceLock<Mutex<ResolveCache>> = OnceLock::new();
    C.get_or_init(Default::default)
}

/// Each path's real place: from the cache when it was resolved lately, the rest in one call.
fn resolve_remote(
    host: &str,
    paths: &[String],
    resolver: &RemoteResolver<'_>,
) -> Result<Vec<Option<String>>, String> {
    let now = Instant::now();
    let mut out: Vec<Option<Option<String>>> = {
        let cache = resolve_cache().lock().unwrap_or_else(|e| e.into_inner());
        paths
            .iter()
            .map(|p| {
                cache
                    .get(&(host.to_string(), p.clone()))
                    .filter(|(at, _)| now.duration_since(*at) < REMOTE_RESOLVE_TTL)
                    .map(|(_, r)| r.clone())
            })
            .collect()
    };
    let missing: Vec<String> = paths
        .iter()
        .zip(&out)
        .filter(|(_, r)| r.is_none())
        .map(|(p, _)| p.clone())
        .collect();
    if !missing.is_empty() {
        let got = resolver(host, &missing)?;
        if got.len() != missing.len() {
            return Err("the machine answered for a different number of paths".into());
        }
        let mut cache = resolve_cache().lock().unwrap_or_else(|e| e.into_inner());
        cache.retain(|_, (at, _)| now.duration_since(*at) < REMOTE_RESOLVE_TTL);
        let mut got = got.into_iter();
        for (p, slot) in paths.iter().zip(out.iter_mut()) {
            if slot.is_none() {
                let r = got.next().flatten();
                cache.insert((host.to_string(), p.clone()), (now, r.clone()));
                *slot = Some(r);
            }
        }
    }
    Ok(out.into_iter().map(Option::flatten).collect())
}

/// Where an `ssh://` path really is on its machine (symlinks followed), as an `ssh://` path.
pub(crate) fn remote_real_path(path: &str) -> Result<String, String> {
    let r = crate::remote::parse(path)
        .ok_or_else(|| format!("\"{path}\" isn't a valid remote path."))?;
    let resolved = resolve_remote(&r.host, std::slice::from_ref(&r.path), &helper_resolve)
        .map_err(|e| format!("Couldn't check \"{path}\" on {}: {e}", r.host))?;
    match resolved.into_iter().next().flatten() {
        Some(p) => Ok(crate::remote::uri::uri(&r.host, &p)),
        None => Err(format!("Couldn't resolve \"{path}\" (broken symlink?).")),
    }
}

fn confine_remote(path: &str, scope: Option<&str>) -> Result<(), String> {
    confine_remote_with(path, scope, &helper_resolve)
}

/// A remote path is allowed inside its scope's remote roots, or in Nyxs' own folder in the
/// machine's home (`~/.nyxs`: sessions, skills). As locally, symlinks are followed: the path
/// and the roots are resolved on the machine (see `resolve_remote`), so a link in the project
/// that points outside it is refused. A path outside the roots as written is refused without
/// asking the machine.
fn confine_remote_with(
    path: &str,
    scope: Option<&str>,
    resolver: &RemoteResolver<'_>,
) -> Result<(), String> {
    let target = crate::remote::parse(path)
        .ok_or_else(|| format!("Access denied: \"{path}\" isn't a valid remote path."))?;
    if target.has_parent_segment() {
        return Err(format!("Access denied: \"{path}\" contains '..'."));
    }
    let mut roots: Vec<crate::remote::RemotePath> = {
        let registry = remote_scopes().lock().unwrap_or_else(|e| e.into_inner());
        let of = |s: &RemoteScope| -> Vec<crate::remote::RemotePath> {
            s.roots
                .iter()
                .cloned()
                .chain(s.extra.keys().filter_map(|u| crate::remote::parse(u)))
                .collect()
        };
        match scope {
            Some(id) => registry.get(id).map(of).unwrap_or_default(),
            None => registry.values().flat_map(of).collect(),
        }
    };
    if let Some(conn) = crate::remote::existing_info(&target.host) {
        roots.push(crate::remote::RemotePath {
            host: target.host.clone(),
            path: format!("{}/.nyxs", conn.home.trim_end_matches('/')),
        });
    }
    roots.retain(|r| r.host == target.host);
    let outside =
        || format!("Access denied: \"{path}\" is outside the project and the allowed folders.");
    if !roots.iter().any(|r| target.is_within(r)) {
        return Err(outside());
    }
    let mut paths = vec![target.path.clone()];
    paths.extend(roots.iter().map(|r| r.path.clone()));
    let resolved = resolve_remote(&target.host, &paths, resolver)
        .map_err(|e| format!("Couldn't check \"{path}\" on {}: {e}", target.host))?;
    let real = |p: &Option<String>| {
        p.as_ref().map(|path| crate::remote::RemotePath {
            host: target.host.clone(),
            path: path.clone(),
        })
    };
    let Some(real_target) = real(&resolved[0]) else {
        return Err(format!(
            "Access denied: couldn't resolve \"{path}\" (broken symlink?)."
        ));
    };
    if resolved[1..]
        .iter()
        .filter_map(real)
        .any(|r| real_target.is_within(&r))
    {
        Ok(())
    } else {
        Err(format!(
            "Access denied: \"{path}\" is outside the project and the allowed folders \
             (including when reached through a symlink)."
        ))
    }
}

pub(crate) fn set_scope_roots(scope: &str, roots: &[String]) {
    let remote: Vec<_> = roots
        .iter()
        .filter_map(|r| crate::remote::parse(r.trim()))
        .collect();
    remote_scopes()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .entry(scope.to_string())
        .or_default()
        .roots = remote;
    let parsed: Vec<PathBuf> = roots.iter().filter_map(|r| absolute_root(r)).collect();
    let mut registry = scopes().lock().unwrap_or_else(|e| e.into_inner());
    registry.entry(scope.to_string()).or_default().roots = parsed;
}

pub(crate) fn add_scope_root(scope: &str, root: &str) {
    if let Some(r) = crate::remote::parse(root.trim()) {
        *remote_scopes()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(scope.to_string())
            .or_default()
            .extra
            .entry(r.uri())
            .or_insert(0) += 1;
        return;
    }
    if let Some(p) = absolute_root(root) {
        let mut registry = scopes().lock().unwrap_or_else(|e| e.into_inner());
        *registry
            .entry(scope.to_string())
            .or_default()
            .extra
            .entry(p)
            .or_insert(0) += 1;
    }
}

pub(crate) fn remove_scope_root(scope: &str, root: &str) {
    if let Some(r) = crate::remote::parse(root.trim()) {
        let mut registry = remote_scopes().lock().unwrap_or_else(|e| e.into_inner());
        if let Some(entry) = registry.get_mut(scope) {
            if let Some(count) = entry.extra.get_mut(&r.uri()) {
                *count -= 1;
                if *count == 0 {
                    entry.extra.remove(&r.uri());
                }
            }
        }
        return;
    }
    let Some(p) = absolute_root(root) else {
        return;
    };
    let mut registry = scopes().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(entry) = registry.get_mut(scope) {
        if let Some(count) = entry.extra.get_mut(&p) {
            *count -= 1;
            if *count == 0 {
                entry.extra.remove(&p);
            }
        }
    }
}

#[tauri::command]
pub fn agent_set_path_scope(scope: String, roots: Vec<String>) {
    set_scope_roots(&scope, &roots);
}

#[tauri::command]
pub fn agent_add_path_scope(scope: String, root: String) {
    add_scope_root(&scope, &root);
}

#[tauri::command]
pub fn agent_remove_path_scope(scope: String, root: String) {
    remove_scope_root(&scope, &root);
}

#[tauri::command]
pub fn agent_allow_ui_path(app: AppHandle, path: String) -> Result<(), String> {
    if crate::remote::is_remote(&path) {
        add_scope_root("__ui__", &path);
        return Ok(());
    }
    let root = absolute_root(&path).ok_or_else(|| format!("Invalid path: {path}"))?;
    if root.is_dir() {
        app.asset_protocol_scope()
            .allow_directory(&root, true)
            .map_err(|e| e.to_string())?;
    }
    add_shared_root(root);
    Ok(())
}

#[cfg(test)]
pub(crate) fn set_scope_roots_for_tests(scope: &str, roots: &[String]) {
    set_scope_roots(scope, roots);
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);

    impl TempDir {
        fn new(tag: &str) -> Self {
            static SEQ: AtomicU64 = AtomicU64::new(0);
            let n = SEQ.fetch_add(1, Ordering::SeqCst);
            let dir = std::env::temp_dir().join(format!(
                "nyxs-scope-{tag}-{}-{n}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }

        fn path(&self, rel: &str) -> String {
            self.0.join(rel).to_string_lossy().to_string()
        }

        fn root(&self) -> String {
            self.0.to_string_lossy().to_string()
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn write(dir: &TempDir, rel: &str, body: &str) -> String {
        let p = dir.path(rel);
        if let Some(parent) = Path::new(&p).parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(&p, body).unwrap();
        p
    }

    #[test]
    fn unregistered_or_empty_scope_fails_closed() {
        let ws = TempDir::new("closed");
        let file = write(&ws, "a.txt", "x");
        assert!(confine(&file, Some("never-registered")).is_err());
        set_scope_roots("empty-scope", &[]);
        assert!(confine(&file, Some("empty-scope")).is_err());
    }

    #[test]
    fn scopes_are_isolated_per_workspace() {
        let a = TempDir::new("ws-a");
        let b = TempDir::new("ws-b");
        let fa = write(&a, "src/a.rs", "a");
        let fb = write(&b, "src/b.rs", "b");
        set_scope_roots("scope-a", &[a.root()]);
        set_scope_roots("scope-b", &[b.root()]);
        assert!(confine(&fa, Some("scope-a")).is_ok());
        assert!(confine(&fb, Some("scope-a")).is_err());
        assert!(confine(&fb, Some("scope-b")).is_ok());
        set_scope_roots("scope-b", &[b.root()]);
        assert!(
            confine(&fa, Some("scope-a")).is_ok(),
            "setting another scope must not clobber this one"
        );
    }

    #[test]
    fn allows_new_files_but_rejects_parent_dir_and_relative_paths() {
        let ws = TempDir::new("new");
        set_scope_roots("scope-new", &[ws.root()]);
        assert!(confine(&ws.path("deep/new/file.txt"), Some("scope-new")).is_ok());
        let escape = format!(
            "{}{}..{}x.txt",
            ws.root(),
            std::path::MAIN_SEPARATOR,
            std::path::MAIN_SEPARATOR
        );
        assert!(confine(&escape, Some("scope-new")).is_err());
        assert!(confine("relative/file.txt", Some("scope-new")).is_err());
    }

    #[test]
    fn extra_roots_are_reference_counted() {
        let ws = TempDir::new("extra-ws");
        let wt = TempDir::new("extra-wt");
        let file = write(&wt, "f.txt", "x");
        set_scope_roots("scope-extra", &[ws.root()]);
        add_scope_root("scope-extra", &wt.root());
        add_scope_root("scope-extra", &wt.root());
        remove_scope_root("scope-extra", &wt.root());
        assert!(confine(&file, Some("scope-extra")).is_ok());
        set_scope_roots("scope-extra", &[ws.root()]);
        assert!(
            confine(&file, Some("scope-extra")).is_ok(),
            "a new turn keeps a running sub-agent's worktree"
        );
        remove_scope_root("scope-extra", &wt.root());
        assert!(confine(&file, Some("scope-extra")).is_err());
    }

    #[test]
    fn unscoped_calls_see_registered_roots_but_nothing_else() {
        let ws = TempDir::new("unscoped-ws");
        let outside = TempDir::new("unscoped-out");
        let inside = write(&ws, "a.txt", "x");
        let secret = write(&outside, "secret.txt", "x");
        set_scope_roots("scope-unscoped", &[ws.root()]);
        assert!(confine(&inside, None).is_ok());
        assert!(confine(&secret, None).is_err());
        add_shared_root(PathBuf::from(outside.root()));
        assert!(confine(&secret, None).is_ok());
        assert!(
            confine(&secret, Some("scope-unscoped")).is_err(),
            "UI roots never leak into an agent scope"
        );
    }

    #[test]
    fn read_only_roots_allow_reads_but_not_writes() {
        let ws = TempDir::new("ro-ws");
        let logs = TempDir::new("ro-logs");
        let log = write(&logs, "run-stdout.log", "full output");
        set_scope_roots("scope-ro", &[ws.root()]);
        assert!(confine(&log, Some("scope-ro")).is_err());
        add_read_only_root(PathBuf::from(logs.root()));
        assert!(confine(&log, Some("scope-ro")).is_ok());
        assert!(confine_write(&log, Some("scope-ro"), false).is_err());
        assert!(confine_write(&log, None, false).is_err());
        assert!(confine(&ws.path("x.txt"), Some("scope-ro")).is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn network_paths_outside_the_roots_are_refused_without_a_lookup() {
        let ws = TempDir::new("unc-ws");
        set_scope_roots("scope-unc", &[ws.root()]);
        assert!(share_of(Path::new(r"C:\Users\a\x.txt")).is_none());
        assert_eq!(
            share_of(Path::new(r"\\?\UNC\Server\Share\x")),
            share_of(Path::new(r"\\server\share\y"))
        );
        // A resolvable-looking host would hang or leak if it were looked up: refused at once.
        let err = confine(r"\\attacker.invalid\s\a.txt", Some("scope-unc")).unwrap_err();
        assert!(err.contains("network share"), "{err}");
        assert!(confine(r"\\.\pipe\x", None).is_err());
        assert!(!share_is_allowed(
            r"\\wsl.localhost\ubuntu",
            Some("scope-unc"),
            true
        ));
        set_scope_roots(
            "scope-unc-wsl",
            &[r"\\wsl.localhost\Ubuntu\home\a\proj".to_string()],
        );
        assert!(share_is_allowed(
            r"\\wsl.localhost\ubuntu",
            Some("scope-unc-wsl"),
            true
        ));
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_cannot_escape_the_scope() {
        let ws = TempDir::new("link-ws");
        let outside = TempDir::new("link-out");
        let secret = write(&outside, "secret.txt", "x");
        std::os::unix::fs::symlink(&secret, ws.path("link.txt")).unwrap();
        std::os::unix::fs::symlink(outside.path("missing.txt"), ws.path("dangling.txt")).unwrap();
        set_scope_roots("scope-link", &[ws.root()]);
        assert!(confine(&ws.path("link.txt"), Some("scope-link")).is_err());
        assert!(confine(&ws.path("dangling.txt"), Some("scope-link")).is_err());
    }

    /// A machine where `link` in the project points to `/etc` and `dangling` to nothing.
    fn fake_machine(
        calls: &AtomicU64,
    ) -> impl Fn(&str, &[String]) -> Result<Vec<Option<String>>, String> + '_ {
        move |_host, paths| {
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(paths
                .iter()
                .map(|p| {
                    if let Some(rest) = p.strip_prefix("/home/me/app/link") {
                        Some(format!("/etc{rest}"))
                    } else if p.ends_with("/dangling") {
                        None
                    } else {
                        Some(p.clone())
                    }
                })
                .collect())
        }
    }

    #[test]
    fn remote_symlinks_cannot_escape_the_scope() {
        let calls = AtomicU64::new(0);
        let machine = fake_machine(&calls);
        set_scope_roots("scope-remote-link", &["ssh://link-host/home/me/app".into()]);
        let check = |p: &str| confine_remote_with(p, Some("scope-remote-link"), &machine);
        assert!(check("ssh://link-host/home/me/app/src/a.ts").is_ok());
        assert!(check("ssh://link-host/home/me/app/src/new/file.ts").is_ok());
        let escaped = check("ssh://link-host/home/me/app/link/passwd").unwrap_err();
        assert!(escaped.contains("through a symlink"), "{escaped}");
        let broken = check("ssh://link-host/home/me/app/dangling").unwrap_err();
        assert!(broken.contains("broken symlink"), "{broken}");
        // Outside as written: refused without asking the machine.
        let before = calls.load(Ordering::SeqCst);
        assert!(check("ssh://link-host/etc/passwd").is_err());
        assert!(check("ssh://other-host/home/me/app/a.ts").is_err());
        assert_eq!(calls.load(Ordering::SeqCst), before);
    }

    #[test]
    fn remote_resolutions_are_reused_for_a_while() {
        let calls = AtomicU64::new(0);
        let machine = fake_machine(&calls);
        set_scope_roots(
            "scope-remote-cache",
            &["ssh://cache-host/home/me/app".into()],
        );
        let check = |p: &str| confine_remote_with(p, Some("scope-remote-cache"), &machine);
        assert!(check("ssh://cache-host/home/me/app/a.ts").is_ok());
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "the path and its root in one call"
        );
        assert!(check("ssh://cache-host/home/me/app/a.ts").is_ok());
        assert_eq!(
            calls.load(Ordering::SeqCst),
            1,
            "the same path again: no call"
        );
        assert!(check("ssh://cache-host/home/me/app/b.ts").is_ok());
        assert_eq!(
            calls.load(Ordering::SeqCst),
            2,
            "a new path: only it is asked for"
        );
        // An entry past its time is asked for again.
        resolve_cache()
            .lock()
            .unwrap()
            .values_mut()
            .for_each(|(at, _)| *at -= REMOTE_RESOLVE_TTL);
        assert!(check("ssh://cache-host/home/me/app/a.ts").is_ok());
        assert_eq!(calls.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn a_machine_that_cant_be_asked_refuses_the_path() {
        set_scope_roots("scope-remote-down", &["ssh://down-host/home/me/app".into()]);
        let down = |_: &str, _: &[String]| -> Result<Vec<Option<String>>, String> {
            Err("not connected".into())
        };
        let err = confine_remote_with(
            "ssh://down-host/home/me/app/a.ts",
            Some("scope-remote-down"),
            &down,
        )
        .unwrap_err();
        assert!(
            err.contains("Couldn't check") && err.contains("not connected"),
            "{err}"
        );
    }

    #[test]
    fn file_commands_refuse_paths_outside_the_scope() {
        let ws = TempDir::new("cmd-ws");
        let outside = TempDir::new("cmd-out");
        let inside = write(&ws, "notes.txt", "hello");
        let secret = write(&outside, "secret.txt", "top secret");
        write(&outside, "img.png", "png");
        write(&outside, "doc.pdf", "%PDF-1.4");
        let scope = Some("scope-cmd".to_string());
        set_scope_roots("scope-cmd", &[ws.root()]);

        assert!(agent_read_file(inside.clone(), None, None, scope.clone())
            .unwrap()
            .contains("hello"));
        assert!(agent_read_file(secret.clone(), None, None, scope.clone()).is_err());
        assert!(agent_read_file(secret.clone(), None, None, None).is_err());
        assert!(agent_read_image(outside.path("img.png"), scope.clone()).is_err());
        assert!(agent_read_pdf(outside.path("doc.pdf"), scope.clone()).is_err());
        assert!(agent_read_pdf_text(outside.path("doc.pdf"), scope.clone()).is_err());
        assert!(nyxs_read_text(secret.clone()).is_err());
        assert!(agent_list_dir(outside.root(), scope.clone()).is_err());
        assert!(agent_list_dir(ws.root(), scope.clone()).is_ok());
        assert!(agent_glob("**/*".into(), outside.root(), None, scope.clone()).is_err());
        assert!(agent_glob(
            "**/*".into(),
            ws.root(),
            Some(outside.root()),
            scope.clone()
        )
        .is_err());
        assert!(agent_grep(
            "secret".into(),
            outside.root(),
            None,
            None,
            None,
            None,
            None,
            None,
            scope.clone()
        )
        .is_err());
        assert!(agent_write_file(
            outside.path("new.txt"),
            "x".into(),
            scope.clone(),
            None,
            None
        )
        .is_err());
        assert!(!Path::new(&outside.path("new.txt")).exists());
        assert!(agent_edit_file(
            secret.clone(),
            "top".into(),
            "no".into(),
            None,
            scope.clone(),
            None,
            None,
            None
        )
        .is_err());
        assert_eq!(fs::read_to_string(&secret).unwrap(), "top secret");
        assert!(agent_write_file(
            ws.path("out/new.txt"),
            "ok".into(),
            scope.clone(),
            None,
            None
        )
        .is_ok());
    }

    #[test]
    fn agent_writes_to_project_settings_need_explicit_approval() {
        let ws = TempDir::new("cfg-ws");
        let settings = write(&ws, ".nyxs/settings.json", "{}");
        let local = ws.path(".nyxs/settings.local.json");
        let scope = Some("scope-cfg".to_string());
        set_scope_roots("scope-cfg", &[ws.root()]);
        let evil = r#"{"permissions":{"allow":["Bash"]}}"#.to_string();

        assert!(
            agent_write_file(settings.clone(), evil.clone(), scope.clone(), None, None).is_err()
        );
        assert!(agent_write_file(
            local.clone(),
            evil.clone(),
            scope.clone(),
            Some(false),
            None
        )
        .is_err());
        assert!(agent_edit_file(
            settings.clone(),
            "{}".into(),
            evil.clone(),
            None,
            scope.clone(),
            None,
            None,
            None
        )
        .is_err());
        let edits = vec![EditOp {
            old_string: "{}".into(),
            new_string: evil.clone(),
            replace_all: None,
        }];
        assert!(agent_multi_edit(settings.clone(), edits, scope.clone(), None, None).is_err());
        assert_eq!(fs::read_to_string(&settings).unwrap(), "{}");
        assert!(!Path::new(&local).exists());

        assert!(agent_write_file(
            settings.clone(),
            evil.clone(),
            scope.clone(),
            Some(true),
            None
        )
        .is_ok());
        assert!(
            agent_write_file(local.clone(), "{}".into(), None, None, None).is_ok(),
            "the settings UI writes without a scope"
        );
        assert!(agent_write_file(
            ws.path(".nyxs/preview.json"),
            "{}".into(),
            scope.clone(),
            None,
            None
        )
        .is_ok());
        assert!(agent_write_file(
            ws.path("settings.json"),
            "{}".into(),
            scope.clone(),
            None,
            None
        )
        .is_ok());
    }

    #[cfg(windows)]
    #[test]
    fn protected_settings_match_case_insensitively_after_resolution() {
        let ws = TempDir::new("cfg-case");
        write(&ws, ".nyxs/settings.json", "{}");
        set_scope_roots("scope-cfg-case", &[ws.root()]);
        let shouted = ws.path(".NYXS/SETTINGS.JSON");
        assert!(agent_write_file(
            shouted,
            "{}".into(),
            Some("scope-cfg-case".into()),
            None,
            None
        )
        .is_err());
    }
}
