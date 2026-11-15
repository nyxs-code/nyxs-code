# nyxs-remote builds

The SSH helper for each system a remote machine can run, bundled with the app
(`bundle.resources` in `tauri.conf.json`). Files are named
`nyxs-remote-<linux|macos|windows>-<x86_64|aarch64>[.exe]`.

Release builds fill this folder in CI (`remote-helpers` job in
`.github/workflows/release.yml`). While developing, `tauri dev` rebuilds what is older than the
helper's sources, this computer's own helper and the Linux x86_64 one, and `npm run remote:build`
does it by hand (Docker is only a fallback). The binaries are not committed.
