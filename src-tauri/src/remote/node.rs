//! Getting a machine ready to run a project's Node dev server: finding out what it lacks, and
//! installing Node in the user's own folders, which needs no administrator and affects nobody
//! else there. The helper puts `~/.local/bin` on the PATH of what it runs (`wrap_command`).

use serde::Serialize;

use crate::agent::cli_process::quote;

use super::procs::{self, Exec};

const CHECK_TIMEOUT_MS: u64 = 30_000;
const PACKAGE_MARKER: &str = "NYXS_PACKAGE_JSON";

/// `{root}` becomes the project's folder, where the search for a lockfile stops.
const CHECK_SCRIPT: &str = r#"root={root}
echo "NODE=$(node --version 2>/dev/null)"
echo "OS=$(uname -s)"
echo "ARCH=$(uname -m)"
if ldd --version 2>&1 | grep -qi musl; then echo MUSL=1; fi
d=$PWD
lock=
while :; do
  for f in package-lock.json npm-shrinkwrap.json pnpm-lock.yaml yarn.lock bun.lock bun.lockb; do
    if [ -e "$d/$f" ]; then lock=$f; break 2; fi
  done
  if [ "$d" = "$root" ] || [ "$d" = / ]; then break; fi
  d=$(dirname "$d")
done
if [ -z "$lock" ]; then d=$PWD; fi
echo "DIR=$d"
echo "LOCK=$lock"
if [ -e "$d/package.json" ]; then echo PACKAGE=1; fi
if [ -n "$(ls -A "$d/node_modules" 2>/dev/null)" ]; then echo MODULES=1; fi
for m in npm yarn pnpm bun; do
  if command -v "$m" >/dev/null 2>&1; then echo "HAS_$m=1"; fi
done
echo NYXS_PACKAGE_JSON
cat package.json 2>/dev/null
exit 0"#;

/// `{major}` is the Node major version to install, or empty for the newest LTS. The archive's
/// checksum is checked when the machine has a tool for it; `index.json` has one release per line.
const INSTALL_SCRIPT: &str = r#"set -e
major={major}
case "$(uname -s)" in Linux) os=linux ;; Darwin) os=darwin ;; *) echo "Unsupported system: $(uname -s)" >&2; exit 92 ;; esac
case "$(uname -m)" in x86_64|amd64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) echo "Unsupported processor: $(uname -m)" >&2; exit 92 ;; esac
get() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1"
  elif command -v wget >/dev/null 2>&1; then wget -qO- "$1"
  else echo "The machine has neither curl nor wget." >&2; exit 91; fi
}
base=https://nodejs.org/dist
echo "Looking for the Node.js release"
index=$(get "$base/index.json")
if [ -n "$major" ]; then line=$(printf '%s\n' "$index" | grep "\"version\":\"v$major\." | head -n 1)
else line=$(printf '%s\n' "$index" | grep '"lts":"' | head -n 1); fi
version=$(printf '%s\n' "$line" | sed -n 's/.*"version":"\(v[0-9.]*\)".*/\1/p')
if [ -z "$version" ]; then echo "No Node.js release found for ${major:-LTS}." >&2; exit 93; fi
name="node-$version-$os-$arch"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
echo "Downloading Node.js $version"
get "$base/$version/$name.tar.gz" > "$tmp/$name.tar.gz"
get "$base/$version/SHASUMS256.txt" > "$tmp/SHASUMS256.txt"
cd "$tmp"
if command -v sha256sum >/dev/null 2>&1; then grep " $name.tar.gz\$" SHASUMS256.txt | sha256sum -c - >/dev/null
elif command -v shasum >/dev/null 2>&1; then grep " $name.tar.gz\$" SHASUMS256.txt | shasum -a 256 -c - >/dev/null; fi
echo "Installing Node.js $version"
tar -xzf "$name.tar.gz"
home_dir="$HOME/.local/share/nyxs/node"
mkdir -p "$home_dir" "$HOME/.local/bin"
rm -rf "${home_dir:?}/$version"
mv "$name" "$home_dir/$version"
for program in node npm npx corepack; do
  ln -sf "$home_dir/$version/bin/$program" "$HOME/.local/bin/$program"
done
"$HOME/.local/bin/node" --version"#;

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteProjectCheck {
    /// The installed version; `None` when there is no Node.
    node: Option<String>,
    /// Node can be installed here (official builds need glibc and a known processor).
    can_install_node: bool,
    /// The major version `engines.node` asks for; `None` means any, so the newest LTS.
    node_major: Option<u32>,
    /// `ssh://` folder dependencies install in; `None` when the project has no package.json.
    package_dir: Option<String>,
    install_command: Option<String>,
    /// The program `install_command` runs.
    manager: Option<String>,
    manager_found: bool,
    modules_present: bool,
}

/// The major version `engines.node` pins, if any. `>=18` takes any newer one, so it asks for
/// nothing in particular; of several alternatives the last is the newest.
fn wanted_major(engines: &str) -> Option<u32> {
    let last = engines.rsplit("||").next()?.trim();
    if last.starts_with('>') || last.starts_with('*') {
        return None;
    }
    let digits: String = last
        .chars()
        .skip_while(|c| !c.is_ascii_digit())
        .take_while(char::is_ascii_digit)
        .collect();
    digits.parse().ok()
}

fn install_command(lock: &str) -> (&'static str, &'static str) {
    match lock {
        "package-lock.json" | "npm-shrinkwrap.json" => ("npm", "npm ci"),
        "pnpm-lock.yaml" => ("pnpm", "pnpm install --frozen-lockfile"),
        "yarn.lock" => ("yarn", "yarn install --frozen-lockfile"),
        "bun.lock" | "bun.lockb" => ("bun", "bun install --frozen-lockfile"),
        _ => ("npm", "npm install"),
    }
}

fn parse_check(host: &str, stdout: &str) -> RemoteProjectCheck {
    let (facts, package) = stdout.split_once(PACKAGE_MARKER).unwrap_or((stdout, ""));
    let fact = |key: &str| {
        facts.lines().find_map(|l| {
            l.strip_prefix(key)
                .and_then(|rest| rest.strip_prefix('='))
                .map(str::trim)
                .filter(|v| !v.is_empty())
        })
    };
    let known_system = matches!(fact("OS"), Some("Linux" | "Darwin"))
        && matches!(fact("ARCH"), Some("x86_64" | "amd64" | "aarch64" | "arm64"));
    let node_major = serde_json::from_str::<serde_json::Value>(package.trim())
        .ok()
        .and_then(|p| p.pointer("/engines/node")?.as_str().and_then(wanted_major));
    let has_package = fact("PACKAGE").is_some();
    let lock = fact("LOCK").unwrap_or("");
    let (manager, command) = install_command(lock);
    let installs = has_package || !lock.is_empty();
    RemoteProjectCheck {
        node: fact("NODE").map(str::to_string),
        can_install_node: known_system && fact("MUSL").is_none(),
        node_major,
        package_dir: fact("DIR")
            .filter(|_| installs)
            .map(|dir| super::uri::uri(host, dir)),
        install_command: installs.then(|| command.to_string()),
        manager: installs.then(|| manager.to_string()),
        manager_found: fact(&format!("HAS_{manager}")).is_some(),
        modules_present: fact("MODULES").is_some(),
    }
}

fn run_check(cwd: &str, root: &str) -> Result<RemoteProjectCheck, String> {
    let dir = super::parse(cwd).ok_or("Not a remote path")?;
    if super::info(&dir.host).map_err(String::from)?.os == "windows" {
        return Err("Preparing a Windows machine isn't supported.".to_string());
    }
    let root = super::parse(root).map_or(dir.path.clone(), |r| r.path);
    let script = CHECK_SCRIPT.replace("{root}", &quote(&root, false));
    let command = format!("exec sh -c {}", quote(&script, false));
    let res = procs::exec(
        &dir.host,
        Exec {
            command: Some(&command),
            argv: None,
            cwd: Some(&dir.path),
            env: None,
            timeout_ms: Some(CHECK_TIMEOUT_MS),
            run_id: None,
        },
    )
    .map_err(String::from)?;
    Ok(parse_check(&dir.host, &res.stdout))
}

/// What the machine lacks to run a Node dev server in `cwd`.
#[tauri::command]
pub async fn remote_project_check(cwd: String, root: String) -> Result<RemoteProjectCheck, String> {
    tauri::async_runtime::spawn_blocking(move || run_check(&cwd, &root))
        .await
        .map_err(|e| e.to_string())?
}

fn install_script(major: Option<u32>) -> String {
    let script = INSTALL_SCRIPT.replace("{major}", &major.map_or(String::new(), |m| m.to_string()));
    format!("exec sh -c {}", quote(&script, false))
}

/// The command that installs Node on a machine, for the page to run where it can show its output.
#[tauri::command]
pub fn remote_node_install_command(major: Option<u32>) -> String {
    install_script(major)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NO_NODE: &str = "NODE=\nOS=Linux\nARCH=x86_64\nDIR=/home/dev/app/desktop\nLOCK=package-lock.json\nPACKAGE=1\nNYXS_PACKAGE_JSON\n{\"engines\":{\"node\":\"^20.19.0\"}}\n";

    #[test]
    fn a_machine_without_node_or_dependencies() {
        let c = parse_check("build-box", NO_NODE);
        assert_eq!(c.node, None);
        assert!(c.can_install_node);
        assert_eq!(c.node_major, Some(20));
        assert_eq!(
            c.package_dir.as_deref(),
            Some("ssh://build-box/home/dev/app/desktop")
        );
        assert_eq!(c.install_command.as_deref(), Some("npm ci"));
        assert!(!c.manager_found && !c.modules_present);
    }

    #[test]
    fn a_machine_with_everything() {
        let out = "Welcome!\nNODE=v24.1.0\nOS=Linux\nARCH=aarch64\nDIR=/a\nLOCK=pnpm-lock.yaml\nPACKAGE=1\nMODULES=1\nHAS_npm=1\nHAS_pnpm=1\nNYXS_PACKAGE_JSON\n{}";
        let c = parse_check("h", out);
        assert_eq!(c.node.as_deref(), Some("v24.1.0"));
        assert_eq!(c.node_major, None);
        assert_eq!(c.manager.as_deref(), Some("pnpm"));
        assert_eq!(
            c.install_command.as_deref(),
            Some("pnpm install --frozen-lockfile")
        );
        assert!(c.manager_found && c.modules_present);
    }

    #[test]
    fn systems_without_official_node_builds_arent_offered_it() {
        let musl = "NODE=\nOS=Linux\nARCH=x86_64\nMUSL=1\nDIR=/a\nLOCK=\nNYXS_PACKAGE_JSON\n";
        assert!(!parse_check("h", musl).can_install_node);
        let arm32 = "NODE=\nOS=Linux\nARCH=armv7l\nDIR=/a\nLOCK=\nNYXS_PACKAGE_JSON\n";
        assert!(!parse_check("h", arm32).can_install_node);
    }

    #[test]
    fn a_folder_that_isnt_a_package_has_nothing_to_install() {
        let c = parse_check(
            "h",
            "NODE=v24.1.0\nOS=Linux\nARCH=x86_64\nDIR=/a\nLOCK=\nNYXS_PACKAGE_JSON\n",
        );
        assert_eq!(
            (c.package_dir, c.install_command, c.manager),
            (None, None, None)
        );
    }

    #[test]
    fn a_package_without_a_lockfile_installs_with_npm() {
        let c = parse_check(
            "h",
            "NODE=\nOS=Linux\nARCH=x86_64\nDIR=/a\nLOCK=\nPACKAGE=1\nNYXS_PACKAGE_JSON\n",
        );
        assert_eq!(c.install_command.as_deref(), Some("npm install"));
    }

    #[test]
    fn reads_the_major_engines_pins() {
        for (engines, major) in [
            ("20.x", Some(20)),
            ("^22.12.0", Some(22)),
            ("~18.20", Some(18)),
            ("20", Some(20)),
            ("^20.19.0 || >=22.12.0", None),
            (">=18", None),
            ("*", None),
            ("lts", None),
        ] {
            assert_eq!(wanted_major(engines), major, "{engines}");
        }
    }

    #[test]
    fn the_install_command_names_the_version_inside_quotes() {
        let pinned = install_script(Some(20));
        assert!(pinned.starts_with("exec sh -c '"));
        assert!(pinned.contains("major=20"));
        assert!(install_script(None).contains("major=\n"));
    }

    /// Against a real machine without Node: `NYXS_SSH_CONFIG=<config> NYXS_REMOTE_TEST_HOST=<host>
    /// cargo test --lib remote::node -- --ignored --nocapture`. Leaves Node in its home folder.
    #[test]
    #[ignore]
    fn installs_node_and_dependencies_on_a_machine() {
        let Ok(host) = std::env::var("NYXS_REMOTE_TEST_HOST") else {
            return;
        };
        let home = super::super::info(&host).unwrap().home;
        let root = format!("{home}/nyxs-node-test");
        let shell = |command: &str, cwd: Option<&str>| {
            let res = procs::exec(
                &host,
                Exec {
                    command: Some(command),
                    argv: None,
                    cwd,
                    env: None,
                    timeout_ms: Some(300_000),
                    run_id: None,
                },
            )
            .unwrap();
            println!(
                "$ {}: {}{}",
                command.chars().take(30).collect::<String>(),
                res.stdout.trim(),
                res.stderr.trim()
            );
            res
        };
        shell(&format!("rm -rf '{root}'; mkdir -p '{root}/app'"), None);
        shell(
            r#"printf '%s' '{"name":"demo","dependencies":{"is-number":"7.0.0"},"engines":{"node":"22.x"}}' > package.json"#,
            Some(&format!("{root}/app")),
        );
        let uri = |p: &str| format!("ssh://{host}{p}");
        let cwd = uri(&format!("{root}/app"));
        let root_uri = uri(&root);

        let before = run_check(&cwd, &root_uri).unwrap();
        println!("before: {before:?}");
        assert_eq!(before.node_major, Some(22));
        assert!(before.can_install_node);
        assert_eq!(before.install_command.as_deref(), Some("npm install"));
        assert!(!before.modules_present);

        if before.node.is_none() {
            let installed = shell(&install_script(before.node_major), None);
            assert_eq!(installed.code, Some(0), "{}", installed.stderr);
        }
        let with_node = run_check(&cwd, &root_uri).unwrap();
        println!("with node: {with_node:?}");
        assert!(with_node
            .node
            .as_deref()
            .is_some_and(|v| v.starts_with("v22.")));
        assert!(with_node.manager_found, "npm should be on the PATH");

        let deps = shell("npm install", Some(&format!("{root}/app")));
        assert_eq!(deps.code, Some(0), "{}", deps.stderr);
        let done = run_check(&cwd, &root_uri).unwrap();
        println!("done: {done:?}");
        assert!(done.modules_present);
        assert_eq!(done.install_command.as_deref(), Some("npm ci"));

        // A lockfile above the server's folder is where a monorepo installs.
        shell(
            "mv package-lock.json .. && mv node_modules .. && mkdir -p web",
            Some(&format!("{root}/app")),
        );
        let nested = run_check(&uri(&format!("{root}/app/web")), &root_uri).unwrap();
        assert_eq!(nested.package_dir.as_deref(), Some(root_uri.as_str()));
        shell(&format!("rm -rf '{root}'"), None);
    }
}
