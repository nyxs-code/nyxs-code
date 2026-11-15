//! How Nyxs names a place on a remote machine: `ssh://<host>/<path>`, where `<host>` is what
//! `ssh` takes (an alias from ~/.ssh/config, `user@server`, `user@server:2222`) and `<path>` is
//! the absolute path there with forward slashes. A Windows machine's `C:\code\app` reads
//! `ssh://casa/C:/code/app`.

pub const SCHEME: &str = "ssh://";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RemotePath {
    pub host: String,
    /// The path on the remote machine: `/home/me/app` or `C:/code/app`.
    pub path: String,
}

/// Whether `host` can go to ssh as the machine: not empty, not something ssh would read as an
/// option (`-oProxyCommand=…`), and without spaces or control characters.
pub fn valid_host(host: &str) -> bool {
    !host.is_empty()
        && !host.starts_with('-')
        && !host.chars().any(|c| c.is_whitespace() || c.is_control())
}

pub fn is_remote(p: &str) -> bool {
    p.starts_with(SCHEME)
}

pub fn parse(p: &str) -> Option<RemotePath> {
    let rest = p.strip_prefix(SCHEME)?;
    let rest = rest.replace('\\', "/");
    let (host, path) = match rest.find('/') {
        Some(i) => (rest[..i].to_string(), rest[i..].to_string()),
        None => (rest.clone(), "/".to_string()),
    };
    if !valid_host(&host) {
        return None;
    }
    let mut path = collapse_slashes(&path);
    // `/C:/code` → `C:/code`: a Windows drive path keeps no leading slash.
    let b = path.as_bytes();
    if b.len() >= 3 && b[0] == b'/' && b[1].is_ascii_alphabetic() && b[2] == b':' {
        path.remove(0);
    }
    if path.len() > 1 && path.ends_with('/') && !path.ends_with(":/") {
        path.pop();
    }
    Some(RemotePath { host, path })
}

fn collapse_slashes(p: &str) -> String {
    let mut out = String::with_capacity(p.len());
    let mut last_slash = false;
    for c in p.chars() {
        if c == '/' {
            if !last_slash {
                out.push(c);
            }
            last_slash = true;
        } else {
            out.push(c);
            last_slash = false;
        }
    }
    out
}

pub fn uri(host: &str, path: &str) -> String {
    let path = path.replace('\\', "/");
    if path.starts_with('/') {
        format!("{SCHEME}{host}{path}")
    } else {
        format!("{SCHEME}{host}/{path}")
    }
}

/// `ssh://host` alone: what the helper puts in front of every path it reports.
pub fn prefix(host: &str) -> String {
    format!("{SCHEME}{host}")
}

impl RemotePath {
    pub fn uri(&self) -> String {
        uri(&self.host, &self.path)
    }

    /// Whether this path is `root` or inside it.
    pub fn is_within(&self, root: &RemotePath) -> bool {
        if self.host != root.host {
            return false;
        }
        let windows = root.path.as_bytes().get(1) == Some(&b':');
        let (a, r) = if windows {
            (self.path.to_lowercase(), root.path.to_lowercase())
        } else {
            (self.path.clone(), root.path.clone())
        };
        a == r || a.starts_with(&format!("{}/", r.trim_end_matches('/')))
    }

    pub fn has_parent_segment(&self) -> bool {
        self.path.split('/').any(|s| s == "..")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_unix_and_windows_paths() {
        let p = parse("ssh://vps/home/me/app/").unwrap();
        assert_eq!(p.host, "vps");
        assert_eq!(p.path, "/home/me/app");
        let w = parse("ssh://me@casa:2222/C:/code/app").unwrap();
        assert_eq!(w.host, "me@casa:2222");
        assert_eq!(w.path, "C:/code/app");
        assert_eq!(w.uri(), "ssh://me@casa:2222/C:/code/app");
        assert_eq!(parse("ssh://vps").unwrap().path, "/");
        assert_eq!(parse("ssh://casa/C:/").unwrap().path, "C:/");
        assert!(parse("ssh:///x").is_none());
        assert!(parse("/home/x").is_none());
    }

    #[test]
    fn a_host_that_ssh_would_read_as_an_option_isnt_a_place() {
        for bad in [
            "ssh://-oProxyCommand=calc/home/me",
            "ssh://-p/x",
            "ssh://bad host/x",
            "ssh://a\tb/x",
            "ssh://a\u{7}b/x",
        ] {
            assert!(parse(bad).is_none(), "{bad:?}");
        }
        assert_eq!(parse("ssh://me@[::1]:22/x").unwrap().host, "me@[::1]:22");
        assert!(valid_host("me@vps-2.example.com:2222"));
        assert!(!valid_host(""));
        assert!(!valid_host("-F/tmp/evil"));
    }
    #[test]
    fn backslashes_from_a_windows_join_still_parse() {
        let p = parse(r"ssh://vps/home/me/app\src\main.ts").unwrap();
        assert_eq!(p.path, "/home/me/app/src/main.ts");
    }

    #[test]
    fn containment_is_per_host_and_segment() {
        let root = parse("ssh://vps/home/me/app").unwrap();
        assert!(parse("ssh://vps/home/me/app/src/a.ts")
            .unwrap()
            .is_within(&root));
        assert!(parse("ssh://vps/home/me/app").unwrap().is_within(&root));
        assert!(!parse("ssh://vps/home/me/apple").unwrap().is_within(&root));
        assert!(!parse("ssh://other/home/me/app/a").unwrap().is_within(&root));
        let win = parse("ssh://casa/C:/Code").unwrap();
        assert!(parse("ssh://casa/c:/code/x").unwrap().is_within(&win));
    }
}
