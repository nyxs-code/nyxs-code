// Builds the SSH helper (src-tauri/remote) into src-tauri/remote/dist for development: this
// computer's own system, plus Linux x86_64, which is what most servers run.
// Release builds make every system's in CI (`remote-helpers` in release.yml).
//
// `--if-stale` is what `tauri dev` runs: it builds only what is older than the helper's sources,
// and a failure doesn't stop the app from starting. The folder isn't in git, so without this it
// keeps whatever was built last, and the app asks the helper for operations it doesn't have yet.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "remote");
const dist = join(root, "dist");
const onlyIfStale = process.argv.includes("--if-stale");

function newestSource() {
  const files = [join(root, "Cargo.toml"), join(root, "Cargo.lock")];
  for (const entry of readdirSync(join(root, "src"), { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) files.push(join(entry.parentPath, entry.name));
  }
  return Math.max(...files.filter(existsSync).map((f) => statSync(f).mtimeMs));
}

function isStale(file) {
  return !onlyIfStale || !existsSync(file) || statSync(file).mtimeMs < newestSource();
}

function buildOwn(os, arch) {
  const exe = os === "windows" ? ".exe" : "";
  const name = `nyxs-remote-${os}-${arch}${exe}`;
  if (!isStale(join(dist, name))) return;
  execFileSync("cargo", ["build", "--release"], { cwd: root, stdio: "inherit" });
  copyFileSync(join(root, "target", "release", `nyxs-remote${exe}`), join(dist, name));
  console.log(`built ${name}`);
}

/** Rust's own linker is enough for a static Linux binary; Docker only when that can't work. */
function buildLinuxWithRust() {
  const triple = "x86_64-unknown-linux-musl";
  try {
    execFileSync("rustup", ["target", "add", triple], { stdio: "ignore" });
    execFileSync(
      "cargo",
      ["build", "--release", "--locked", "--target", triple, "--config", `target.${triple}.linker="rust-lld"`],
      { cwd: root, stdio: "inherit" },
    );
  } catch {
    return false;
  }
  copyFileSync(join(root, "target", triple, "release", "nyxs-remote"), join(dist, "nyxs-remote-linux-x86_64"));
  return true;
}

function buildLinuxWithDocker() {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
  } catch {
    return false;
  }
  execFileSync(
    "docker",
    [
      "run", "--rm",
      "-v", `${resolve(root, "..")}:/src`,
      "-v", "nyxs-remote-cargo:/usr/local/cargo/registry",
      "-w", "/src/remote",
      "rust:1-alpine",
      "sh", "-c",
      "apk add --no-cache musl-dev >/dev/null && CARGO_TARGET_DIR=/src/remote/target-linux cargo build --release --target x86_64-unknown-linux-musl && cp target-linux/x86_64-unknown-linux-musl/release/nyxs-remote dist/nyxs-remote-linux-x86_64",
    ],
    { stdio: "inherit", env: { ...process.env, MSYS_NO_PATHCONV: "1" } },
  );
  return true;
}

function buildLinux() {
  if (!isStale(join(dist, "nyxs-remote-linux-x86_64"))) return;
  if (buildLinuxWithRust() || buildLinuxWithDocker()) console.log("built nyxs-remote-linux-x86_64");
  else console.log("Couldn't build the Linux x86_64 helper: it needs the Rust target x86_64-unknown-linux-musl or Docker.");
}

try {
  mkdirSync(dist, { recursive: true });
  const os = { win32: "windows", darwin: "macos", linux: "linux" }[process.platform];
  const arch = { x64: "x86_64", arm64: "aarch64" }[process.arch];
  buildOwn(os, arch);
  if (os !== "linux" || arch !== "x86_64") buildLinux();
} catch (err) {
  if (!onlyIfStale) throw err;
  console.warn(`Couldn't update the SSH helper; remote machines may fail: ${err.message}`);
}
