use std::collections::{BTreeMap, HashSet};

pub const VAULT_ACCOUNT: &str = "nyxs-vault";

pub trait SecretBackend {
    fn get(&self, account: &str) -> Result<Option<String>, String>;
    fn set(&self, account: &str, secret: &str) -> Result<(), String>;
    fn delete(&self, account: &str) -> Result<(), String>;
}

pub struct Vault {
    secrets: Option<BTreeMap<String, String>>,
    checked_legacy: HashSet<String>,
}

impl Vault {
    pub fn new() -> Self {
        Vault {
            secrets: None,
            checked_legacy: HashSet::new(),
        }
    }

    fn load(
        &mut self,
        backend: &dyn SecretBackend,
    ) -> Result<&mut BTreeMap<String, String>, String> {
        if self.secrets.is_none() {
            let map = match backend.get(VAULT_ACCOUNT)? {
                Some(json) => serde_json::from_str(&json)
                    .map_err(|e| format!("Nyxs's secure store is corrupted: {e}"))?,
                None => BTreeMap::new(),
            };
            self.secrets = Some(map);
        }
        Ok(self.secrets.as_mut().unwrap())
    }

    fn persist(&self, backend: &dyn SecretBackend) -> Result<(), String> {
        let map = self.secrets.as_ref().unwrap();
        if map.is_empty() {
            return backend.delete(VAULT_ACCOUNT);
        }
        let json =
            serde_json::to_string(map).map_err(|e| format!("Couldn't save the secret: {e}"))?;
        backend.set(VAULT_ACCOUNT, &json)
    }

    fn drop_legacy(&mut self, backend: &dyn SecretBackend, account: &str) {
        if self.checked_legacy.insert(account.to_string()) {
            let _ = backend.delete(account);
        }
    }

    pub fn get(
        &mut self,
        backend: &dyn SecretBackend,
        account: &str,
    ) -> Result<Option<String>, String> {
        if let Some(found) = self.load(backend)?.get(account) {
            return Ok(Some(found.clone()));
        }
        if !self.checked_legacy.insert(account.to_string()) {
            return Ok(None);
        }
        let Some(legacy) = backend.get(account)? else {
            return Ok(None);
        };
        self.load(backend)?
            .insert(account.to_string(), legacy.clone());
        self.persist(backend)?;
        let _ = backend.delete(account);
        Ok(Some(legacy))
    }

    pub fn set(
        &mut self,
        backend: &dyn SecretBackend,
        account: &str,
        secret: &str,
    ) -> Result<(), String> {
        self.load(backend)?
            .insert(account.to_string(), secret.to_string());
        self.persist(backend)?;
        self.drop_legacy(backend, account);
        Ok(())
    }

    pub fn delete(&mut self, backend: &dyn SecretBackend, account: &str) -> Result<(), String> {
        if self.load(backend)?.remove(account).is_some() {
            self.persist(backend)?;
        }
        self.drop_legacy(backend, account);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[derive(Default)]
    struct Mem {
        items: RefCell<BTreeMap<String, String>>,
        reads: RefCell<Vec<String>>,
    }

    impl Mem {
        fn with(items: &[(&str, &str)]) -> Self {
            let mem = Mem::default();
            for (k, v) in items {
                mem.items.borrow_mut().insert(k.to_string(), v.to_string());
            }
            mem
        }
        fn reads_of(&self, account: &str) -> usize {
            self.reads
                .borrow()
                .iter()
                .filter(|a| a.as_str() == account)
                .count()
        }
    }

    impl SecretBackend for Mem {
        fn get(&self, account: &str) -> Result<Option<String>, String> {
            self.reads.borrow_mut().push(account.to_string());
            Ok(self.items.borrow().get(account).cloned())
        }
        fn set(&self, account: &str, secret: &str) -> Result<(), String> {
            self.items
                .borrow_mut()
                .insert(account.to_string(), secret.to_string());
            Ok(())
        }
        fn delete(&self, account: &str) -> Result<(), String> {
            self.items.borrow_mut().remove(account);
            Ok(())
        }
    }

    #[test]
    fn reads_the_keychain_once_for_many_secrets() {
        let mem = Mem::default();
        let mut vault = Vault::new();
        vault.set(&mem, "session", "tok").unwrap();
        vault.set(&mem, "provider:u:openai", "sk-1").unwrap();
        mem.reads.borrow_mut().clear();
        let mut fresh = Vault::new();
        assert_eq!(fresh.get(&mem, "session").unwrap().as_deref(), Some("tok"));
        assert_eq!(
            fresh.get(&mem, "provider:u:openai").unwrap().as_deref(),
            Some("sk-1")
        );
        assert_eq!(
            fresh.get(&mem, "provider:u:openai").unwrap().as_deref(),
            Some("sk-1")
        );
        assert_eq!(mem.reads_of(VAULT_ACCOUNT), 1);
        assert_eq!(mem.items.borrow().len(), 1);
    }

    #[test]
    fn moves_old_per_secret_items_into_the_vault() {
        let mem = Mem::with(&[("session", "old-tok"), ("provider:u:groq", "gk")]);
        let mut vault = Vault::new();
        assert_eq!(
            vault.get(&mem, "session").unwrap().as_deref(),
            Some("old-tok")
        );
        assert_eq!(
            vault.get(&mem, "provider:u:groq").unwrap().as_deref(),
            Some("gk")
        );
        let items = mem.items.borrow();
        assert_eq!(items.keys().collect::<Vec<_>>(), vec![VAULT_ACCOUNT]);
        let stored: BTreeMap<String, String> = serde_json::from_str(&items[VAULT_ACCOUNT]).unwrap();
        assert_eq!(stored.get("session").map(String::as_str), Some("old-tok"));
    }

    #[test]
    fn looks_for_a_missing_old_item_only_once() {
        let mem = Mem::default();
        let mut vault = Vault::new();
        assert_eq!(vault.get(&mem, "provider:u:none").unwrap(), None);
        assert_eq!(vault.get(&mem, "provider:u:none").unwrap(), None);
        assert_eq!(mem.reads_of("provider:u:none"), 1);
    }

    #[test]
    fn new_values_win_over_old_items_and_remove_them() {
        let mem = Mem::with(&[("session", "stale")]);
        let mut vault = Vault::new();
        vault.set(&mem, "session", "fresh").unwrap();
        assert!(!mem.items.borrow().contains_key("session"));
        assert_eq!(
            Vault::new().get(&mem, "session").unwrap().as_deref(),
            Some("fresh")
        );
    }

    #[test]
    fn deleting_the_last_secret_removes_the_vault_item() {
        let mem = Mem::with(&[("plugin:x:token", "p")]);
        let mut vault = Vault::new();
        vault.set(&mem, "session", "tok").unwrap();
        vault.delete(&mem, "session").unwrap();
        vault.delete(&mem, "plugin:x:token").unwrap();
        assert!(mem.items.borrow().is_empty());
        assert_eq!(vault.get(&mem, "session").unwrap(), None);
    }

    #[test]
    fn a_damaged_vault_is_reported_and_left_untouched() {
        let mem = Mem::with(&[(VAULT_ACCOUNT, "{not json")]);
        let mut vault = Vault::new();
        assert!(vault.get(&mem, "session").is_err());
        assert!(vault.set(&mem, "session", "tok").is_err());
        assert_eq!(mem.items.borrow()[VAULT_ACCOUNT], "{not json");
    }
}
