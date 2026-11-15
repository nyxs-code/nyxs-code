//! "Export as standalone Remotion project": a Nyxs project plus the runtime's sources (engine,
//! entry, player/render scripts, package.json) in one folder that works outside Nyxs with
//! `npm install && npx remotion studio`.

use std::fs;
use std::path::{Path, PathBuf};

use tauri::AppHandle;

use super::env;
use super::project;

/// Never copied from the template: an install, sample projects, and the overlay applied
/// separately.
const SKIP: &[&str] = &[
    "node_modules",
    ".git",
    "out",
    ".cache",
    "standalone",
    "examples",
];

pub(super) fn copy_tree(from: &Path, to: &Path, skip: &[&str]) -> std::io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let name = entry.file_name();
        if skip.iter().any(|s| name == *s) {
            continue;
        }
        let target = to.join(&name);
        if entry.file_type()?.is_dir() {
            copy_tree(&entry.path(), &target, skip)?;
        } else {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

/// The entry the standalone copy starts from, relative to it.
pub fn standalone_entry(dest: &Path) -> &'static str {
    [
        "entry/index.ts",
        "entry/index.tsx",
        "src/index.ts",
        "src/index.tsx",
    ]
    .into_iter()
    .find(|p| dest.join(p).is_file())
    .unwrap_or("entry/index.ts")
}

/// A remotion.config.ts that gives the copy what Nyxs passes at run time: the entry, and the
/// `@project` alias pointing at the folder itself (media sit in public/media).
pub fn remotion_config(entry: &str) -> String {
    format!(
        r#"// Written by Nyxs so this video runs on its own: npm install && npx remotion studio
import path from "node:path";
import {{ Config }} from "@remotion/cli/config";

Config.setEntryPoint("{entry}");
Config.overrideWebpackConfig((config) => ({{
  ...config,
  resolve: {{
    ...config.resolve,
    alias: {{ ...(config.resolve?.alias ?? {{}}), "@project": path.resolve(process.cwd()) }},
  }},
}}));
"#
    )
}

/// Sets `"name"` in package.json to `name`, keeping the rest of the file as written.
pub fn rename_package(text: &str, name: &str) -> String {
    let re = regex::Regex::new(r#""name"\s*:\s*"[^"]*""#).expect("valid regex");
    re.replace(text, format!("\"name\": \"{name}\"").as_str())
        .into_owned()
}

pub fn export_standalone(
    app: &AppHandle,
    workspace: &str,
    slug: &str,
    dest: &str,
) -> Result<String, String> {
    let dir = project::project_dir(workspace, slug)?;
    if !project::is_light(&dir) {
        return Err("This is already a standalone Remotion project.".into());
    }
    let dest = PathBuf::from(dest.trim());
    if !dest.is_absolute() {
        return Err(format!(
            "Export to an absolute folder, not {}",
            dest.display()
        ));
    }
    if dest.starts_with(&dir) {
        return Err("The export can't go inside the project itself.".into());
    }
    if fs::read_dir(&dest).is_ok_and(|mut d| d.next().is_some()) {
        return Err(format!(
            "{} is not empty: pick an empty or new folder.",
            dest.display()
        ));
    }
    let template = env::template_dir(app)?;
    let io = |e: std::io::Error| format!("Couldn't export to {}: {e}", dest.display());
    copy_tree(&template, &dest, SKIP).map_err(io)?;

    // The project's data replaces the template's samples.
    fs::copy(dir.join(project::TIMELINE), dest.join(project::TIMELINE)).map_err(io)?;
    for sub in ["scenes", "media"] {
        let from = dir.join(sub);
        let to = if sub == "media" {
            dest.join("public").join("media")
        } else {
            dest.join(sub)
        };
        if from.is_dir() {
            copy_tree(&from, &to, &[]).map_err(io)?;
        }
    }
    let overlay = template.join("standalone");
    if overlay.is_dir() {
        copy_tree(&overlay, &dest, &[]).map_err(io)?;
    }
    let config = dest.join("remotion.config.ts");
    if !config.exists() {
        fs::write(&config, remotion_config(standalone_entry(&dest))).map_err(io)?;
    }
    let pkg = dest.join("package.json");
    if let Ok(text) = fs::read_to_string(&pkg) {
        fs::write(&pkg, rename_package(&text, &project::slugify(slug))).map_err(io)?;
    }
    Ok(dest.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_a_config_for_the_copy() {
        let c = remotion_config("entry/index.ts");
        assert!(c.contains("Config.setEntryPoint(\"entry/index.ts\");"));
        assert!(c.contains("\"@project\": path.resolve(process.cwd())"));
        let dir = std::env::temp_dir().join(format!("nyxs-video-export-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::write(dir.join("src/index.ts"), "").unwrap();
        assert_eq!(standalone_entry(&dir), "src/index.ts");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn renames_the_package() {
        let text = "{\n  \"name\": \"nyxs-video-runtime\",\n  \"private\": true\n}\n";
        assert_eq!(
            rename_package(text, "intro"),
            "{\n  \"name\": \"intro\",\n  \"private\": true\n}\n"
        );
    }
}
