//! End to end against a real runtime install (npm, Chrome Headless Shell, renders): minutes and
//! network on the first run, so it's ignored by default. Run it with
//! `cargo test --lib video::e2e_tests -- --ignored --nocapture`.
//! The runtime stays in `<temp>/nyxs-video-e2e/runtime` so later runs reuse it.

use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use serde_json::{json, Value};

use super::{env, player, project, render, runtime};

fn template() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("video-template")
}

fn copy_without_modules(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for e in fs::read_dir(from).unwrap().flatten() {
        if e.file_name() == "node_modules" {
            continue;
        }
        let target = to.join(e.file_name());
        if e.path().is_dir() {
            copy_without_modules(&e.path(), &target);
        } else {
            fs::copy(e.path(), &target).unwrap();
        }
    }
}

fn light_project(root: &Path, name: &str, background: &str, rt: &Path) -> PathBuf {
    let dir = root.join(name);
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join("scenes")).unwrap();
    fs::create_dir_all(dir.join("media")).unwrap();
    let mut t = project::initial_timeline(
        None,
        name,
        &project::Preset {
            width: 320,
            height: 180,
            fps: 30.0,
            duration_in_frames: 15,
        },
    );
    t["compositions"][0]["background"] = json!(background);
    project::write_json(&dir.join(project::TIMELINE), &t).unwrap();
    project::write_tsconfig(&dir, rt).unwrap();
    dir
}

fn set_clips(dir: &Path, track_kind: &str, clips: Value, assets: Value) {
    let mut t = project::read_timeline_value(dir).unwrap();
    for track in t["compositions"][0]["tracks"].as_array_mut().unwrap() {
        if track["kind"] == track_kind {
            track["clips"] = clips.clone();
        }
    }
    t["assets"] = assets;
    project::write_json(&dir.join(project::TIMELINE), &t).unwrap();
}

/// Runs render.mjs the way the app does and returns its stdout events.
fn run_script(rt: &Path, ws: &str, slug: &str, dir: &Path, request: Value) -> Vec<Value> {
    let cmd = render::script_command(rt, ws, slug, dir, &format!("e2e-{slug}"), request).unwrap();
    let out = env::run_capture(cmd, Duration::from_secs(600)).unwrap();
    let events: Vec<Value> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    assert!(
        out.ok(),
        "render.mjs failed: {:?}\n{}",
        events.last(),
        out.tail()
    );
    events
}

#[test]
#[ignore]
fn installs_the_runtime_once_and_renders_two_light_projects() {
    let base = std::env::temp_dir().join("nyxs-video-e2e");
    let root = base.join("runtime");
    std::env::set_var(
        "NYXS_PROJECTS_ROOT",
        std::env::temp_dir().join("nyxs-test-projects"),
    );

    // A frozen copy: other sessions edit the template while this runs, and every caller must
    // hash the same sources (the app computes the version once per run for the same reason).
    let snapshot = base.join("template");
    let _ = fs::remove_dir_all(&snapshot);
    copy_without_modules(&template(), &snapshot);

    // Three concurrent callers: one installs, the others wait for it and get the same folder.
    let copies = AtomicUsize::new(0);
    let report = |stage: &str, line: Option<&str>, _p: Option<f64>| {
        if stage == "copying" {
            copies.fetch_add(1, Ordering::SeqCst);
        }
        if stage != "installing" || line.is_some_and(|l| l.starts_with("Reusing")) {
            println!("[{stage}] {}", line.unwrap_or(""));
        }
    };
    let dirs: Vec<PathBuf> = std::thread::scope(|s| {
        let handles: Vec<_> = (0..3)
            .map(|_| s.spawn(|| runtime::install_at(&snapshot, &root, &report).unwrap()))
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });
    assert!(dirs.iter().all(|d| d == &dirs[0]));
    assert!(
        copies.load(Ordering::SeqCst) <= 1,
        "only one install may run"
    );
    let rt = dirs[0].clone();
    assert!(rt.join("READY").is_file());
    assert!(!rt
        .join("node_modules")
        .join(".bin")
        .join("nonexistent")
        .exists());

    let projects = base.join("workspace").join("videos");
    let ws = base.join("workspace").to_string_lossy().into_owned();

    // A: a custom scene from the project's scenes/, importing `remotion` it doesn't have.
    let a = light_project(&projects, "alpha", "#aa0000", &rt);
    fs::write(
        a.join("scenes").join("Hello.tsx"),
        "import React from \"react\";\nimport { AbsoluteFill, useCurrentFrame } from \"remotion\";\nexport const Hello: React.FC = () => {\n  const frame = useCurrentFrame();\n  return <AbsoluteFill style={{ justifyContent: \"center\", alignItems: \"center\", color: \"white\", fontSize: 48 }}>Scene {frame}</AbsoluteFill>;\n};\n",
    )
    .unwrap();
    set_clips(
        &a,
        "text",
        json!([{ "id": "s1", "type": "scene", "file": "Hello", "exportName": "Hello", "from": 0, "durationInFrames": 15 }]),
        json!([]),
    );
    assert!(!a.join("node_modules").exists() && !a.join("package.json").exists());
    let still_a = a.join("out").join("a.png");
    fs::create_dir_all(still_a.parent().unwrap()).unwrap();
    let ev = run_script(
        &rt,
        &ws,
        "alpha",
        &a,
        json!({ "still": true, "compositionId": "Main", "frame": 5, "output": still_a.to_string_lossy(),
                "bundleDir": project::cache_dir(&ws, "alpha").unwrap().join("render/bundle-e2e-alpha").to_string_lossy() }),
    );
    assert_eq!(ev.last().unwrap()["type"], "done");
    assert!(fs::metadata(&still_a).unwrap().len() > 0);
    println!("still A: {}", still_a.display());

    // B: an image from its media/ (served through the junction) and a text, rendered to MP4.
    let b = light_project(&projects, "beta", "#0000aa", &rt);
    fs::copy(&still_a, b.join("media").join("pic.png")).unwrap();
    set_clips(
        &b,
        "video",
        json!([{ "id": "i1", "type": "image", "assetId": "pic", "fit": "contain", "from": 0, "durationInFrames": 15 }]),
        json!([{ "id": "pic", "kind": "image", "src": "media/pic.png", "name": "pic", "width": 320, "height": 180 }]),
    );
    let still_b = b.join("out").join("b.png");
    fs::create_dir_all(still_b.parent().unwrap()).unwrap();
    let cache_b = project::cache_dir(&ws, "beta").unwrap().join("render");
    run_script(
        &rt,
        &ws,
        "beta",
        &b,
        json!({ "still": true, "compositionId": "Main", "frame": 3, "output": still_b.to_string_lossy(),
                "bundleDir": cache_b.join("bundle-e2e-beta").to_string_lossy() }),
    );
    let mp4 = b.join("out").join("b.mp4");
    let ev = run_script(
        &rt,
        &ws,
        "beta",
        &b,
        json!({ "compositionId": "Main", "codec": "h264", "crf": 28, "output": mp4.to_string_lossy(),
                "bundleDir": cache_b.join("bundle-e2e-beta2").to_string_lossy() }),
    );
    assert!(ev.iter().any(|e| e["stage"] == "rendering"));
    assert_eq!(ev.last().unwrap()["type"], "done");
    assert!(fs::metadata(&mp4).unwrap().len() > 0);
    println!("still B: {}\nmp4 B: {}", still_b.display(), mp4.display());

    let ev = run_script(
        &rt,
        &ws,
        "beta",
        &b,
        json!({ "list": true, "bundleDir": cache_b.join("bundle-e2e-beta3").to_string_lossy() }),
    );
    let list = render::parse_compositions_line(&ev.last().unwrap().to_string()).unwrap();
    assert_eq!((list[0].id.as_str(), list[0].width), ("Main", 320));

    // The runtime's ffprobe reads the project's render.
    let args: Vec<String> = [
        "ffprobe",
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_streams",
    ]
    .iter()
    .map(|s| s.to_string())
    .chain([mp4.to_string_lossy().into_owned()])
    .collect();
    let out = env::run_capture(
        env::toolchain().remotion(&rt, &args).unwrap(),
        Duration::from_secs(60),
    )
    .unwrap();
    assert!(out.ok(), "{}", out.tail());
    assert!(String::from_utf8_lossy(&out.stdout).contains("\"width\": 320"));

    // The player for B: the runtime's serve.mjs with the app's own arguments, serving the
    // project's media with ranges.
    let outdir = project::cache_dir(&ws, "beta").unwrap().join("player");
    fs::create_dir_all(&outdir).unwrap();
    let args = player::serve_args(&b, &outdir, &rt, true);
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let mut cmd = env::toolchain()
        .node_script(&rt, &rt.join("nyxs").join("serve.mjs"), &args)
        .unwrap();
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    let mut child = cmd.spawn().unwrap();
    let stdout = child.stdout.take().unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(p) = player::parse_port_line(&line) {
                let _ = tx.send(p);
            }
        }
    });
    let port = rx.recv_timeout(Duration::from_secs(120));
    let checked = port.map(|port| {
        let http = reqwest::blocking::Client::new();
        let page = http
            .get(format!("http://127.0.0.1:{port}/"))
            .send()
            .unwrap();
        let pic = http
            .get(format!("http://127.0.0.1:{port}/media/pic.png"))
            .header("Range", "bytes=0-7")
            .send()
            .unwrap();
        (
            page.status().as_u16(),
            pic.status().as_u16(),
            pic.bytes().unwrap().to_vec(),
        )
    });
    env::kill_tree(&mut child);
    let (page, pic, head) = checked.expect("serve.mjs printed no NYXS_PLAYER_PORT");
    println!("player: / -> {page}, /media/pic.png (range) -> {pic}");
    assert_eq!(page, 200);
    assert_eq!(pic, 206);
    assert_eq!(&head[..], b"\x89PNG\r\n\x1a\n");

    // The picker's automatic thumbnail of A, at ~10 %, a third of the size.
    let poster = super::posters::render_poster(&rt, &ws, "alpha", &a).unwrap();
    let png = fs::read(&poster).unwrap();
    let width = u32::from_be_bytes([png[16], png[17], png[18], png[19]]);
    println!("poster: {} ({width} px wide)", poster.display());
    assert_eq!(width, (320.0f64 * 0.34).round() as u32);

    // Still neither project has node_modules or a package.json.
    for p in [&a, &b] {
        assert!(!p.join("node_modules").exists() && !p.join("package.json").exists());
    }
}

fn copy_all(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for e in fs::read_dir(from).unwrap().flatten() {
        let target = to.join(e.file_name());
        if e.path().is_dir() {
            copy_all(&e.path(), &target);
        } else {
            fs::copy(e.path(), &target).unwrap();
        }
    }
}

/// Converts a COPY of a real project of the first design and renders it on the runtime.
/// `NYXS_VIDEO_LEGACY_SAMPLE=D:\optimicer\videos\nyxs-demo-2 cargo test --lib
/// video::e2e_tests::converts -- --ignored --nocapture` (needs the runtime test above first).
#[test]
#[ignore]
fn converts_a_real_old_project_and_renders_it() {
    let Some(sample) = std::env::var_os("NYXS_VIDEO_LEGACY_SAMPLE") else {
        println!("set NYXS_VIDEO_LEGACY_SAMPLE to an old-layout project to run this");
        return;
    };
    std::env::set_var(
        "NYXS_PROJECTS_ROOT",
        std::env::temp_dir().join("nyxs-test-projects"),
    );
    let base = std::env::temp_dir().join("nyxs-video-e2e");
    let rt = runtime::any_ready_dir_in(&base.join("runtime")).expect("run the runtime test first");
    let ws = base.join("legacy-ws");
    let dir = ws.join("videos").join("legacy");
    let _ = fs::remove_dir_all(&ws);
    copy_all(Path::new(&sample), &dir);
    assert!(super::convert::is_legacy(&dir));
    let backup = base.join("legacy-backup");
    let _ = fs::remove_dir_all(&backup);
    super::convert::convert_dir(&dir, &backup, &rt).unwrap();
    assert!(project::is_light(&dir));
    let mut names: Vec<String> = fs::read_dir(&dir)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    println!("converted: {names:?}");
    println!(
        "scenes: {:?}",
        fs::read_dir(dir.join("scenes"))
            .unwrap()
            .flatten()
            .map(|e| e.file_name())
            .collect::<Vec<_>>()
    );

    let t = project::read_timeline_value(&dir).unwrap();
    let comp = t["compositions"][0]["id"].as_str().unwrap().to_string();
    let ws_s = ws.to_string_lossy().into_owned();
    let still = dir.join("out").join("converted.png");
    fs::create_dir_all(still.parent().unwrap()).unwrap();
    let ev = run_script(
        &rt,
        &ws_s,
        "legacy",
        &dir,
        json!({ "still": true, "compositionId": comp, "frame": 45, "output": still.to_string_lossy(),
                "bundleDir": project::cache_dir(&ws_s, "legacy").unwrap().join("render/bundle-e2e-legacy").to_string_lossy() }),
    );
    assert_eq!(ev.last().unwrap()["type"], "done");
    println!("still: {}", still.display());
}

/// Real servers: closing a project keeps its player warm, reopening is instant on the same port,
/// a third project stops the longest idle one, and a kill gives a new server.
/// Needs the runtime test above first.
#[test]
#[ignore]
fn keeps_players_warm() {
    std::env::set_var(
        "NYXS_PROJECTS_ROOT",
        std::env::temp_dir().join("nyxs-test-projects"),
    );
    let base = std::env::temp_dir().join("nyxs-video-e2e");
    let rt = runtime::any_ready_dir_in(&base.join("runtime")).expect("run the runtime test first");
    let ws = base.join("warm-ws");
    let _ = fs::remove_dir_all(&ws);
    let w = ws.to_string_lossy().into_owned();
    for slug in ["a", "b", "c"] {
        light_project(&ws.join("videos"), slug, "#000000", &rt);
    }
    // What the app does before spawning node for a start.
    let t = std::time::Instant::now();
    let _ = project::project_dir(&w, "a").unwrap();
    let _ = env::toolchain();
    project::write_tsconfig(&ws.join("videos").join("a"), &rt).unwrap();
    println!("before the spawn: {:?}", t.elapsed());
    let runtime_dir = || Ok(rt.clone());
    let start = |slug: &str| {
        let t = std::time::Instant::now();
        let info = player::start_server(&runtime_dir, &w, slug, false).unwrap();
        println!("start {slug}: port {} in {:?}", info.port, t.elapsed());
        (info.port, t.elapsed())
    };
    let alive = |port: u16| {
        std::net::TcpStream::connect_timeout(
            &([127, 0, 0, 1], port).into(),
            Duration::from_millis(500),
        )
        .is_ok()
    };

    let (a, _) = start("a");
    player::release(&w, "a").unwrap();
    assert!(alive(a), "closing the project must not stop its server");
    let (again, reuse) = start("a");
    assert_eq!(again, a);
    assert!(reuse < Duration::from_millis(200), "reuse took {reuse:?}");
    player::release(&w, "a").unwrap();

    let (b, _) = start("b");
    player::release(&w, "b").unwrap();
    assert!(alive(a) && alive(b), "two servers fit");

    // A third one stops the longest idle (a), not the more recent b.
    let (c, _) = start("c");
    std::thread::sleep(Duration::from_secs(3));
    assert!(!alive(a), "the longest idle server should be gone");
    assert!(alive(b) && alive(c));

    player::kill(&w, "c").unwrap();
    assert!(!alive(c));
    // A new server (the OS may hand it the same port number).
    let (c2, _) = start("c");
    assert!(alive(c2));

    player::shutdown_all();
    let _ = fs::remove_dir_all(&ws);
}
