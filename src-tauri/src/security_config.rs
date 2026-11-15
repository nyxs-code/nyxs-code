use serde_json::Value;
use urlpattern::{UrlPattern, UrlPatternInit, UrlPatternMatchInput};

const TAURI_CONF: &str = include_str!("../tauri.conf.json");
const DEFAULT_CAPABILITY: &str = include_str!("../capabilities/default.json");

fn security() -> Value {
    let conf: Value = serde_json::from_str(TAURI_CONF).unwrap();
    conf["app"]["security"].clone()
}

fn sources(csp: &Value, directive: &str) -> Vec<String> {
    match &csp[directive] {
        Value::Array(items) => items
            .iter()
            .map(|v| v.as_str().unwrap().to_string())
            .collect(),
        Value::String(s) => s.split_whitespace().map(str::to_string).collect(),
        _ => Vec::new(),
    }
}

fn plugin_pattern(raw: &str) -> UrlPattern {
    let mut init = UrlPatternInit::parse_constructor_string::<regex::Regex>(raw, None)
        .unwrap_or_else(|e| panic!("{raw} is not a valid URL pattern: {e}"));
    if init.search.as_ref().map(|p| p.is_empty()).unwrap_or(true) {
        init.search.replace("*".to_string());
    }
    if init.hash.as_ref().map(|p| p.is_empty()).unwrap_or(true) {
        init.hash.replace("*".to_string());
    }
    if init
        .pathname
        .as_ref()
        .map(|p| p.is_empty() || p == "/")
        .unwrap_or(true)
    {
        init.pathname.replace("*".to_string());
    }
    UrlPattern::parse(init, Default::default()).unwrap_or_else(|e| panic!("{raw}: {e}"))
}

struct HttpScope {
    allow: Vec<UrlPattern>,
    deny: Vec<UrlPattern>,
}

impl HttpScope {
    fn load() -> Self {
        let cap: Value = serde_json::from_str(DEFAULT_CAPABILITY).unwrap();
        let http = cap["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["identifier"] == "http:default")
            .expect("http:default permission")
            .clone();
        let parse = |key: &str| -> Vec<UrlPattern> {
            http[key]
                .as_array()
                .map(|items| {
                    items
                        .iter()
                        .map(|e| plugin_pattern(e["url"].as_str().unwrap()))
                        .collect()
                })
                .unwrap_or_default()
        };
        HttpScope {
            allow: parse("allow"),
            deny: parse("deny"),
        }
    }

    fn allows(&self, url: &str) -> bool {
        let hit = |p: &UrlPattern| {
            p.test(UrlPatternMatchInput::Url(url.parse().unwrap()))
                .unwrap_or(false)
        };
        !self.deny.iter().any(hit) && self.allow.iter().any(hit)
    }
}

#[test]
fn csp_is_enforced_without_inline_or_eval_scripts() {
    let csp = &security()["csp"];
    assert!(csp.is_object() || csp.is_string(), "csp must be defined");
    let script = sources(csp, "script-src");
    assert_eq!(script, vec!["'self'"]);
    assert_eq!(sources(csp, "default-src"), vec!["'self'"]);
    assert_eq!(sources(csp, "object-src"), vec!["'none'"]);
    assert_eq!(sources(csp, "frame-ancestors"), vec!["'none'"]);
    let connect = sources(csp, "connect-src");
    assert!(
        connect.contains(&"ipc:".to_string())
            && connect.contains(&"http://ipc.localhost".to_string())
    );
    for wildcard in ["*", "https:", "http:", "ws:", "wss:"] {
        assert!(
            !connect.contains(&wildcard.to_string()),
            "connect-src must not allow {wildcard}"
        );
    }
    let frames = sources(csp, "frame-src");
    assert!(frames.contains(&"http://nyxspreview.localhost".to_string()));
    // Each preview site is a port on that host; no other localhost server may be framed.
    assert!(frames.contains(&"http://nyxspreview.localhost:*".to_string()));
    assert!(!frames.iter().any(|f| f.contains("*.localhost")));
    assert!(frames.contains(&"nyxspreview:".to_string()));
}

#[test]
fn dev_csp_only_relaxes_what_vite_needs() {
    let sec = security();
    let (prod, dev) = (&sec["csp"], &sec["devCsp"]);
    assert!(!sources(dev, "script-src").contains(&"'unsafe-eval'".to_string()));
    let dev_connect = sources(dev, "connect-src");
    assert!(dev_connect.contains(&"ws://localhost:1420".to_string()));
    for directive in [
        "default-src",
        "object-src",
        "frame-src",
        "img-src",
        "base-uri",
        "form-action",
    ] {
        assert_eq!(
            sources(prod, directive),
            sources(dev, directive),
            "{directive} differs between csp and devCsp"
        );
    }
}

#[test]
fn style_src_keeps_unsafe_inline_effective() {
    let sec = security();
    let disabled = sec["dangerousDisableAssetCspModification"]
        .as_array()
        .expect("style-src must not get nonces");
    assert!(disabled.iter().any(|v| v == "style-src"));
    assert!(!disabled.iter().any(|v| v == "script-src"));
}

#[test]
fn asset_protocol_is_limited_to_app_data() {
    let scope = &security()["assetProtocol"]["scope"];
    let entries: Vec<&str> = match scope {
        Value::Array(items) => items.iter().filter_map(|v| v.as_str()).collect(),
        Value::Object(map) => map["allow"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|v| v.as_str())
            .collect(),
        _ => panic!("asset scope must be a list"),
    };
    assert!(!entries.is_empty());
    for e in entries {
        assert!(
            e != "**" && e != "*" && !e.starts_with("$HOME/**") && e.starts_with('$'),
            "asset scope too broad: {e}"
        );
    }
}

#[test]
fn http_capability_allows_providers_and_lan_but_not_cleartext_internet() {
    let scope = HttpScope::load();
    for ok in [
        "https://api.anthropic.com/v1/messages",
        "https://generativelanguage.googleapis.com/v1beta/models",
        "https://my-proxy.example.com:8443/v1/chat/completions",
        "http://localhost:11434/api/tags",
        "http://127.0.0.1:1234/v1/models",
        "http://192.168.1.20:11434/v1/chat/completions",
        "http://10.0.0.5:8000/v1",
        "http://172.20.0.3:8080/v1",
        "http://gpu-box.local:11434/api/tags",
    ] {
        assert!(scope.allows(ok), "{ok} should be allowed");
    }
    for blocked in [
        "http://example.com/",
        "http://api.openai.com/v1/models",
        "http://172.32.0.1/",
        "http://8.8.8.8/",
        "http://169.254.169.254/latest/meta-data/",
        "https://169.254.169.254/latest/meta-data/",
        "http://metadata.google.internal/computeMetadata/v1/",
        "file:///C:/Windows/win.ini",
    ] {
        assert!(!scope.allows(blocked), "{blocked} should be blocked");
    }
}

#[test]
fn http_capability_blocks_metadata_and_link_local_in_every_spelling() {
    let scope = HttpScope::load();
    for blocked in [
        // The IPv4 metadata address written as a number, in hex, or mapped into IPv6: the URL
        // parser turns all of them into the same host before the deny list sees it.
        "https://2852039166/latest/meta-data/",
        "https://0xa9fea9fe/latest/meta-data/",
        "https://[::ffff:169.254.169.254]/latest/meta-data/",
        "https://[::ffff:a9fe:a9fe]/latest/meta-data/",
        // IPv6 link-local (fe80::/10) and AWS's IPv6 metadata endpoint.
        "https://[fe80::1]/",
        "https://[febf::abcd:1]:8443/",
        "https://[fd00:ec2::254]/latest/meta-data/",
    ] {
        assert!(!scope.allows(blocked), "{blocked} should be blocked");
    }
    for ok in ["https://[2606:4700:4700::1111]/", "https://[fd12:3456::1]/"] {
        assert!(scope.allows(ok), "{ok} should be allowed");
    }
}

#[test]
fn csp_frames_and_connections_have_no_wildcards() {
    let csp = &security()["csp"];
    for directive in ["frame-src", "connect-src", "script-src", "worker-src"] {
        for wildcard in ["*", "https:", "http:", "'unsafe-inline'", "'unsafe-eval'"] {
            assert!(
                !sources(csp, directive).contains(&wildcard.to_string()),
                "{directive} must not allow {wildcard}"
            );
        }
    }
}
