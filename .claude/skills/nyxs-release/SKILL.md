---
name: nyxs-release
description: How to cut a Nyxs release (new version for the auto-updater) from a checkout of this repo. Use when the user asks to release, publish, "sacar la release", "subir a main y sacar versión", bump the version, or push a version tag.
---

# Releasing Nyxs

A release is a **version tag pushed to GitHub**. `.github/workflows/release.yml` builds every
desktop target (Windows NSIS, macOS arm64/x64, Linux AppImage/deb), signs them and publishes
them with the updater manifest (`latest.json`) to the public repo
`nyxs-code/nyxs-code`. Installed apps then show "Actualización disponible".

The repo carries the released version (since v0.8.24): `package.json`, `package-lock.json`,
`src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and `src-tauri/Cargo.lock`. Set all five with
`node scripts/set-version.mjs X.Y.Z` in the release commit; don't edit them by hand. The workflow's
"Align version with the tag" step still writes the tag's version before building, and warns when
the repo didn't match.

## Before anything

1. **Git in this checkout needs** `git -c safe.directory=<checkout path> …` (owner SID differs).
2. **Other Claude sessions share the checkout.** Run `ListAgents`; if a peer is busy, ask it
   (SendMessage) before committing. Check `git status`, `git stash list`.
3. **GitHub account:** releases are tagged in `nyxs-code/nyxs-code` (`origin`), whose `release`
   environment holds the signing secrets; a fork can't release. Push with an account that has
   write access to it: `gh auth status`, and `gh auth switch -u <that account>` if
   another one is active.
4. `git fetch origin` and make sure `main` isn't behind (`git rev-list --left-right --count origin/main...HEAD`).

## Checks (the same ones CI runs)

`.github/workflows/ci.yml` has three jobs (frontend, e2e, rust); run every step of each, once:

```bash
node node_modules/typescript/bin/tsc -p tsconfig.app.json --noEmit   # NOT `tsc -p .`: tsconfig.json has "files": [] and checks nothing
node node_modules/vitest/vitest.mjs run
npm run lint
node node_modules/typescript/bin/tsc -p tsconfig.e2e.json --noEmit
npx playwright test --workers=2 --reporter=line                       # CI runs npm run test:e2e
cd src-tauri && cargo fmt --check && cargo clippy --all-targets --locked -- -D warnings && cargo test --lib --locked
```

All must pass. Fix failures before releasing.

- **`cargo fmt --check` is easy to forget**: CI fails on it in both Rust jobs even when clippy and
  the tests pass. Code written by other sessions often isn't formatted; run `cargo fmt` and
  commit it.
- **E2E with `--workers=2`**: one pass, not repeated. Don't add CPU load or `--repeat-each` on the
  user's PC; that's for when they ask.
- A test that fails on CI and passes locally is not "flaky" until you know why. Twice the
  address bar E2E failed on CI only (`example.com/docsREAD`) from a real race that the faster
  local machine hid. Read the failure's expected/received, find the cause, then decide.
- A test known to be intermittent (the local backlog's "Tests" section, if you keep one) may be
  re-run once alone; if it passes, say so in the summary.

## Version and changelog

- Next version: latest tag + 1 patch (`git tag --sort=-creatordate | head -1`, e.g. v0.8.11 → v0.8.12).
  A minor bump (0.9.0) only if the user asks.
- Add an entry **at the top** of `CHANGELOG` in `src/lib/changelog.ts`; the app shows it in
  "Novedades". English, user-facing, one sentence per item, grouped in `added` / `improved` /
  `fixed`, date like `"October 22, 2026"`. Describe what the user notices, not the code.
  Read `git log <last tag>..HEAD` and the uncommitted diff to cover every session's work.
- Give the entry its update card (`card`): the animated slides the installed app shows when it
  offers this version. Follow the `nyxs-update-card` skill, and don't tag until its unit test
  and its audit pass (CI runs both).

## Commits, push, tag

1. Commit the work (one or more commits, imperative subject, English), each ending with the
   Co-Authored-By line from the system reminder. Stage and commit in one command.
2. `node scripts/set-version.mjs X.Y.Z`, then commit it together with the changelog as
   `Release vX.Y.Z: <3-5 highlights, comma separated>`.
3. `git push origin main`
4. **Wait for CI on that commit** (`gh run list --workflow CI --limit 1`, then
   `gh run watch <id> --exit-status`, ≈6 min). If it fails, fix and push before tagging: a tag
   on a red commit publishes a release CI never approved, and its fixes only ship in the next one.
5. `git tag vX.Y.Z && git push origin vX.Y.Z` — this starts the Release workflow. Check with
   `git ls-remote --tags origin vX.Y.Z` that the tag really reached GitHub (a push piped through
   `Select-String` in PowerShell once reported nothing and skipped the tag).

## Watching it

- `gh run list --workflow Release --limit 3`, then `gh run watch <id> --exit-status` (≈15–25 min;
  run it in the background and check back).
- When it finishes: `gh release view vX.Y.Z -R nyxs-code/nyxs-code` lists the assets and
  `latest.json`.
- A macOS job "cancelled" with no log, annotated "The job was not acquired by Runner of type
  hosted", is GitHub's macOS runner capacity, not the code: `gh run rerun <id> --failed` (CI and
  Release alike) and wait.
- A failed build: read `gh run view <id> --log-failed`, fix, commit, then move the tag
  (`git tag -f vX.Y.Z && git push -f origin vX.Y.Z`) only if nothing was published yet;
  otherwise release the next patch.

Afterwards switch gh back if it was on another account (`gh auth switch -u <that account>`).
