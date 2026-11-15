use std::path::Path;

use ignore::{DirEntry, WalkBuilder};

pub const IGNORED_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "target",
    "dist",
    "build",
    ".next",
    ".nyxs",
    ".venv",
    "venv",
    "__pycache__",
    ".cache",
    "coverage",
    ".turbo",
];

const SECRET_EXTS: &[&str] = &[
    "pem", "key", "p12", "pfx", "keystore", "jks", "kdbx", "asc", "gpg", "ppk",
];

const SECRET_NAMES: &[&str] = &[
    ".npmrc",
    ".pypirc",
    ".netrc",
    ".git-credentials",
    "credentials",
    "credentials.json",
    "secrets.json",
    "secrets.yaml",
    "secrets.yml",
    "service-account.json",
    "id_rsa",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
];

pub fn is_secret_file(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if name.starts_with(".env") {
        return !(name.ends_with(".example")
            || name.ends_with(".sample")
            || name.ends_with(".template"));
    }
    if SECRET_NAMES.contains(&name.as_str())
        || name.starts_with("id_rsa")
        || name.starts_with("id_ed25519")
    {
        return true;
    }
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| SECRET_EXTS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn is_ignored_dir(entry: &DirEntry) -> bool {
    entry.file_type().map(|t| t.is_dir()).unwrap_or(false)
        && entry
            .file_name()
            .to_str()
            .map(|n| IGNORED_DIRS.contains(&n))
            .unwrap_or(false)
}

pub fn project_files(root: impl AsRef<Path>) -> impl Iterator<Item = DirEntry> {
    WalkBuilder::new(root)
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .require_git(false)
        .parents(true)
        .filter_entry(|e| !is_ignored_dir(e))
        .build()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flags_secret_files() {
        for p in [
            ".env",
            ".env.local",
            "certs/server.pem",
            "nyxs.key",
            "id_rsa",
            "id_ed25519.pub",
            ".npmrc",
        ] {
            assert!(is_secret_file(Path::new(p)), "{p}");
        }
        for p in [
            ".env.example",
            "src/main.rs",
            "README.md",
            "keys.ts",
            "package.json",
        ] {
            assert!(!is_secret_file(Path::new(p)), "{p}");
        }
    }
}
