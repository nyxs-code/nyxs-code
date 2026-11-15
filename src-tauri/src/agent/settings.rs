use super::secret_vault::{SecretBackend, Vault};
use super::vfs;
use super::*;

fn settings_path(source: &str, workspace: Option<&str>) -> Result<String, String> {
    let project_dir = |ws: Option<&str>| -> Result<String, String> {
        let ws = ws
            .filter(|w| !w.is_empty())
            .ok_or_else(|| "A workspace is required for these settings".to_string())?;
        Ok(vfs::join(ws, ".nyxs"))
    };
    match source {
        "user" => Ok(home_dir()?
            .join(".nyxs")
            .join("settings.json")
            .to_string_lossy()
            .to_string()),
        "project" => Ok(vfs::join(&project_dir(workspace)?, "settings.json")),
        "local" => Ok(vfs::join(&project_dir(workspace)?, "settings.local.json")),
        other => Err(format!("Unknown settings source: {other}")),
    }
}

#[tauri::command(async)]
pub fn nyxs_read_settings(source: String, workspace: Option<String>) -> Result<String, String> {
    let path = settings_path(&source, workspace.as_deref())?;
    Ok(vfs::read_to_string(&path).unwrap_or_default())
}

#[tauri::command(async)]
pub fn nyxs_write_settings(
    source: String,
    workspace: Option<String>,
    json: String,
) -> Result<(), String> {
    let path = settings_path(&source, workspace.as_deref())?;
    if !crate::remote::is_remote(&path) {
        if let Some(parent) = Path::new(&path).parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Couldn't create the settings folder: {e}"))?;
        }
    }
    vfs::write_atomic(&path, json.as_bytes())
        .map_err(|e| format!("Couldn't save the settings: {e}"))
}

struct Keyring {
    service: String,
}

impl Keyring {
    fn new(app: &AppHandle) -> Self {
        Keyring {
            service: app.config().identifier.clone(),
        }
    }

    fn entry(&self, account: &str) -> Result<keyring::Entry, String> {
        keyring::Entry::new(&self.service, account)
            .map_err(|e| format!("Couldn't open the secure store: {e}"))
    }

    /// The same secret under the identifier the app had up to 0.8.48 (`crate::identifier`),
    /// for the published app only: a test or dev build with an identifier of its own never
    /// takes the user's secrets.
    fn legacy_entry(&self, account: &str) -> Option<keyring::Entry> {
        if self.service != crate::identifier::IDENTIFIER {
            return None;
        }
        keyring::Entry::new(crate::identifier::LEGACY_IDENTIFIER, account).ok()
    }

    /// A secret saved before the identifier changed moves to the new one the first time it's
    /// read; the keychain can't list its items, so they can't all move at start-up.
    fn adopt_legacy(&self, account: &str) -> Result<Option<String>, String> {
        let Some(old) = self.legacy_entry(account) else {
            return Ok(None);
        };
        let Ok(secret) = old.get_password() else {
            return Ok(None);
        };
        self.set(account, &secret)?;
        let _ = old.delete_credential();
        log::info!("identifier: moved the secret {account} to the new keychain service");
        Ok(Some(secret))
    }
}

impl SecretBackend for Keyring {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        match self.entry(account)?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => self.adopt_legacy(account),
            Err(e) => Err(format!("Couldn't read the secret: {e}")),
        }
    }

    fn set(&self, account: &str, secret: &str) -> Result<(), String> {
        self.entry(account)?
            .set_password(secret)
            .map_err(|e| format!("Couldn't save the secret: {e}"))
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        // A secret never read since the identifier changed is still under the old one, and
        // the next read would bring it back.
        if let Some(old) = self.legacy_entry(account) {
            let _ = old.delete_credential();
        }
        match self.entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("Couldn't delete the secret: {e}")),
        }
    }
}

const ONE_KEYCHAIN_ITEM: bool = cfg!(target_os = "macos");

fn with_vault<T>(
    backend: &Keyring,
    f: impl FnOnce(&mut Vault, &Keyring) -> Result<T, String>,
) -> Result<T, String> {
    static VAULT: OnceLock<Mutex<Vault>> = OnceLock::new();
    let mut vault = VAULT
        .get_or_init(|| Mutex::new(Vault::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    f(&mut vault, backend)
}

#[tauri::command(async)]
pub fn nyxs_secret_get(app: AppHandle, account: String) -> Result<Option<String>, String> {
    if let Some(found) = crate::test_data_dir::secret_get(&account) {
        return found;
    }
    let backend = Keyring::new(&app);
    if ONE_KEYCHAIN_ITEM {
        return with_vault(&backend, |v, b| v.get(b, &account));
    }
    backend.get(&account)
}

#[tauri::command(async)]
pub fn nyxs_secret_set(app: AppHandle, account: String, secret: String) -> Result<(), String> {
    if let Some(done) = crate::test_data_dir::secret_set(&account, &secret) {
        return done;
    }
    let backend = Keyring::new(&app);
    if ONE_KEYCHAIN_ITEM {
        return with_vault(&backend, |v, b| v.set(b, &account, &secret));
    }
    backend.set(&account, &secret)
}

#[tauri::command(async)]
pub fn nyxs_secret_delete(app: AppHandle, account: String) -> Result<(), String> {
    if let Some(done) = crate::test_data_dir::secret_delete(&account) {
        return done;
    }
    let backend = Keyring::new(&app);
    if ONE_KEYCHAIN_ITEM {
        return with_vault(&backend, |v, b| v.delete(b, &account));
    }
    backend.delete(&account)
}
