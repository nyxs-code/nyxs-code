//! The four tasks through their real Rust path, against a runtime with node_modules. Ignored by
//! default: point `NYXS_VIDEO_TOOLS_RUNTIME` at an installed runtime whose `nyxs/` is current and run
//! `cargo test --lib video::tools_e2e_tests -- --ignored --nocapture`.

use std::fs;
use std::path::PathBuf;

use serde_json::{json, Value};

use super::{project, tools};

fn fixture(name: &str) -> (String, PathBuf, PathBuf) {
    let runtime = PathBuf::from(
        std::env::var("NYXS_VIDEO_TOOLS_RUNTIME").expect("NYXS_VIDEO_TOOLS_RUNTIME is not set"),
    );
    let base = std::env::temp_dir().join("nyxs-tools-e2e");
    std::env::set_var("NYXS_PROJECTS_ROOT", base.join("projects"));
    let ws = base.join(format!("ws-{name}"));
    let _ = fs::remove_dir_all(&ws);
    let dir = ws.join("videos").join("demo");
    let workspace = ws.to_string_lossy().into_owned();
    fs::create_dir_all(dir.join("scenes")).unwrap();
    fs::create_dir_all(dir.join("media")).unwrap();
    let mut t = project::initial_timeline(
        None,
        "demo",
        &project::Preset {
            width: 640,
            height: 360,
            fps: 30.0,
            duration_in_frames: 90,
        },
    );
    t["compositions"][0]["background"] = json!("#204060");
    project::write_json(&dir.join(project::TIMELINE), &t).unwrap();
    project::write_tsconfig(&dir, &runtime).unwrap();
    (workspace, dir, runtime)
}

fn print(label: &str, v: &Value) {
    let text = v.to_string();
    println!("{label}: {}", &text[..text.len().min(900)]);
}

#[test]
#[ignore]
fn runs_every_task_for_real() {
    let (ws, dir, rt) = fixture("all");
    let seen = std::sync::Mutex::new(Vec::new());
    let report = |p: tools::ToolProgress| seen.lock().unwrap().push(p);

    let first = tools::contact_sheet(&rt, &ws, "demo", "j1", json!({"count": 4}), &report).unwrap();
    print("sheet", &first);
    assert_eq!(first["bundleReused"], false);
    assert_eq!(first["frames"].as_array().unwrap().len(), 4);
    assert_eq!(first["frames"][3]["frame"], 89);
    assert!(fs::metadata(first["path"].as_str().unwrap()).unwrap().len() > 1000);
    assert!(!seen.lock().unwrap().is_empty(), "no progress reported");

    // A timeline-only edit must keep the bundle, and must show in the result.
    let mut t = project::read_timeline_value(&dir).unwrap();
    t["compositions"][0]["background"] = json!("#a02020");
    project::write_json(&dir.join(project::TIMELINE), &t).unwrap();
    let second = tools::proxy(
        &rt,
        &ws,
        "demo",
        "j2",
        json!({"frameRange": [0, 29], "fps": 10, "height": 180}),
        &report,
    )
    .unwrap();
    print("proxy", &second);
    assert_eq!(second["bundleReused"], true);
    assert_eq!(second["frames"], 10);
    assert_eq!(
        (second["width"].as_u64(), second["height"].as_u64()),
        (Some(320), Some(180))
    );

    // A new scene file is code: it must rebuild.
    fs::write(
        dir.join("scenes").join("Extra.tsx"),
        "export default function Extra() { return null; }\n",
    )
    .unwrap();
    let third =
        tools::contact_sheet(&rt, &ws, "demo", "j3", json!({"frames": [5]}), &report).unwrap();
    assert_eq!(third["bundleReused"], false);

    let html = "data:text/html,<h1>Filmed</h1><button onclick=\"fetch('http://127.0.0.1:9/x',{method:'POST'})\">Go</button>";
    let recorded = tools::record(
        &rt,
        &ws,
        "demo",
        "j4",
        json!({
            "name": "My clip",
            "viewport": {"width": 640, "height": 360, "scale": 2},
            "steps": [
                {"type": "goto", "url": html},
                {"type": "click", "text": "Go"},
                {"type": "wait", "ms": 300},
            ],
        }),
        &report,
    )
    .unwrap();
    print("record", &recorded);
    assert_eq!(recorded["asset"]["src"], "media/My-clip.mp4");
    assert_eq!(recorded["asset"]["kind"], "video");
    assert_eq!(recorded["asset"]["width"], 1280);
    assert_eq!(recorded["asset"]["height"], 720);
    assert!(recorded["asset"]["durationInFrames"].as_u64().unwrap() > 10);
    assert_eq!(recorded["blocked"][0], "POST http://127.0.0.1:9/x");
    assert!(dir.join("media").join("My-clip.mp4").is_file());
    let timeline_after = project::read_timeline_value(&dir).unwrap();
    assert_eq!(
        timeline_after["assets"], t["assets"],
        "the store owns the timeline"
    );

    let failed = tools::record(
        &rt,
        &ws,
        "demo",
        "j5",
        json!({"steps": [{"type": "goto", "url": html}, {"type": "click", "text": "Nope", "timeoutMs": 500}]}),
        &report,
    )
    .unwrap_err();
    println!("record failure: {failed}");
    assert!(failed.contains("Step 2 (click)") && failed.contains("\"Nope\""));
    assert!(
        fs::read_dir(dir.join("media")).unwrap().count() == 1,
        "a failure leaves no clip"
    );

    let bed = tools::music(
        &rt,
        &ws,
        "demo",
        "j6",
        json!({"mood": "confident", "durationSecs": 12, "cuts": [4.4], "voiceRanges": [[2, 6]]}),
        &report,
    )
    .unwrap();
    print("music", &bed);
    assert_eq!(bed["asset"]["src"], "media/music-confident.wav");
    assert_eq!(bed["asset"]["kind"], "audio");
    assert_eq!(bed["asset"]["durationInFrames"], 360);
    assert!(!bed["ducking"].as_array().unwrap().is_empty());

    // The asset sheet reads the clip just recorded, once it's in the timeline.
    let mut t = project::read_timeline_value(&dir).unwrap();
    t["assets"] = json!([recorded["asset"]]);
    project::write_json(&dir.join(project::TIMELINE), &t).unwrap();
    let id = recorded["asset"]["id"].as_str().unwrap();
    let sheet = tools::contact_sheet(
        &rt,
        &ws,
        "demo",
        "j7",
        json!({"assetId": id, "count": 3}),
        &report,
    )
    .unwrap();
    print("asset sheet", &sheet);
    assert_eq!(sheet["bundleReused"], Value::Null);
    assert_eq!(sheet["frames"].as_array().unwrap().len(), 3);

    let wrong = tools::contact_sheet(&rt, &ws, "demo", "j8", json!({"assetId": "nope"}), &report);
    assert!(wrong.is_err());

    // Nothing is left behind in the work area.
    let tools_dir = project::cache_dir(&ws, "demo").unwrap().join("tools");
    let left: Vec<_> = fs::read_dir(&tools_dir)
        .unwrap()
        .flatten()
        .map(|e| e.file_name())
        .collect();
    assert!(left.is_empty(), "left in the work area: {left:?}");
}

/// What the app does for a render: the real render.mjs inside the priority job, with NVENC when the
/// machine has it. Prints every process's priority while it runs: 6 is below normal, 8 normal.
#[cfg(windows)]
#[test]
#[ignore]
fn renders_inside_the_priority_job() {
    use super::render;
    use std::io::{BufRead, BufReader};
    use std::process::Stdio;

    let (ws, dir, rt) = fixture("job");
    let output = dir.join("out.mp4");
    let cache = project::cache_dir(&ws, "demo").unwrap();
    let request = json!({
        "compositionId": "Main",
        "codec": "h264",
        "crf": 16,
        "scale": 1,
        "muted": true,
        "output": output.to_string_lossy(),
        "bundleDir": cache.join("render").join("bundle-job").to_string_lossy(),
    });
    let t = project::read_timeline_value(&dir).unwrap();
    assert_eq!(t["compositions"][0]["id"], "Main");
    let mut cmd = render::script_command(&rt, &ws, "demo", &dir, "job", request).unwrap();
    cmd.stdout(Stdio::piped()).stderr(Stdio::null());
    let mut child = cmd.spawn().unwrap();
    render::keep_below_normal(&child);
    let out = child.stdout.take().unwrap();

    let done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let sampler = {
        let done = done.clone();
        std::thread::spawn(move || {
            let mut seen = std::collections::BTreeSet::new();
            while !done.load(std::sync::atomic::Ordering::SeqCst) {
                let list = std::process::Command::new("powershell")
                    .args([
                        "-NoProfile",
                        "-Command",
                        "Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'chrome-headless|remotion|ffmpeg' } | ForEach-Object { $_.Name + ' ' + $_.Priority }",
                    ])
                    .output()
                    .unwrap();
                for line in String::from_utf8_lossy(&list.stdout).lines() {
                    seen.insert(line.trim().to_string());
                }
            }
            seen
        })
    };
    let mut encoders = Vec::new();
    let mut last = Value::Null;
    for line in BufReader::new(out).lines().map_while(Result::ok) {
        if let Ok(event) = serde_json::from_str::<Value>(&line) {
            if event["type"] == "encoder" {
                encoders.push(event["encoder"].as_str().unwrap_or("").to_string());
            }
            last = event;
        }
    }
    let status = child.wait().unwrap();
    done.store(true, std::sync::atomic::Ordering::SeqCst);
    let seen = sampler.join().unwrap();
    println!("encoders: {encoders:?}\nlast: {last}\nprocesses (name, priority): {seen:#?}");
    assert!(status.success(), "{last}");
    assert_eq!(last["type"], "done");
    assert!(output.is_file());
    assert!(!seen.is_empty(), "the sampler saw no process");
    let above: Vec<_> = seen.iter().filter(|l| !l.ends_with(" 6")).collect();
    assert!(above.is_empty(), "not below normal: {above:?}");
}

#[test]
#[ignore]
fn cancelling_stops_a_task_and_cleans_up() {
    let (ws, _dir, rt) = fixture("cancel");
    std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_secs(3));
        tools::cancel("cancel-me");
    });
    let html = "data:text/html,<h1>Long</h1>";
    let err = tools::record(
        &rt,
        &ws,
        "demo",
        "cancel-me",
        json!({"steps": [{"type": "goto", "url": html}, {"type": "wait", "ms": 60000}]}),
        &|_| {},
    )
    .unwrap_err();
    assert_eq!(err, "Cancelled.");
    let work = project::cache_dir(&ws, "demo")
        .unwrap()
        .join("tools")
        .join("work-cancel-me");
    assert!(!work.exists(), "the work folder stayed");
}
