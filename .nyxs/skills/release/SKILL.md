---
name: release
description: Publish a new Nyxs version — update the changelog, tag, and ship it to users via the auto-updater.
when_to_use: When the user wants to release or publish a new version of the Nyxs app, "cut a release", ship an update, or bump the app version for users.
---

# Publish a new Nyxs release

Nyxs ships signed auto-updates. A GitHub Action in `nyxs-code/nyxs-code`
(its `release` environment holds the signing secrets) builds the Windows installer, signs
it with the updater key, and publishes the installer + `latest.json` to the
Releases of the PUBLIC repo `nyxs-code/nyxs-code`. Installed apps read that manifest and
show the "Update available" alert in the sidebar; the changelog modal shows
what changed.

Everything is in English (project convention — see the `i18n` skill).

## Steps

1. **Pick the new version** `X.Y.Z` (semver). It must be HIGHER than the current
   `version` in `src-tauri/tauri.conf.json`, or installed apps won't see an update.

2. **Update the changelog** so users see what's new — use the **`changelog`
   skill** for this. It reads the commits since the last tag, keeps only the
   client-facing changes (dropping internal ones), lets you choose what ships,
   words entries so the update card picks a fitting icon, and inserts the new
   entry at the TOP of the `CHANGELOG` array in `src/lib/changelog.ts`. The
   entry's `version` must match this release's `X.Y.Z`.

3. **Commit on `main`** (changelog + any code changes for this version):
   - `git add -A`
   - `git commit -m "..."` (concise, focused on the "why")
   - `git push origin main`

4. **Tag and push** to trigger the release build:
   - `git tag vX.Y.Z`   (note the leading `v`)
   - `git push origin vX.Y.Z`

   The workflow `.github/workflows/release.yml` strips the `v`, writes `X.Y.Z`
   into `tauri.conf.json` + `package.json`, builds, signs, and publishes the
   release to the public repo.

5. **Verify** (optional): the workflow takes ~10-20 min. Check that the release
   appears at `https://github.com/nyxs-code/nyxs-code/releases/latest`
   with `Nyxs_X.Y.Z_x64-setup.exe` and a `latest.json` whose `version` equals
   `X.Y.Z`. You can watch the run under the Actions tab of `nyxs-code`.

## Rules / gotchas

- The tag MUST be `vX.Y.Z` with a leading `v`. The changelog entry's `version`
  must match the tag minus the `v`.
- The installed app's self-version comes from `src-tauri/tauri.conf.json`. An
  update only appears when the published version is strictly higher.
- NEVER lose the signing key at `.tauri-keys/nyxs.key` — without it, updates can
  never be signed again. It is also stored as the CI secret
  `TAURI_SIGNING_PRIVATE_KEY`.
- Do NOT reuse a tag for different content. To re-run a release for the same
  version: delete the GitHub release and the tag (in both the repo you tagged and
  the public `nyxs-code/nyxs-code`), then re-create the tag.
- The public repo (`nyxs-code/nyxs-code`) must stay public: the auto-updater can't
  download assets from a private repo. Keep it public.
- The build only runs if the GitHub account's Actions are enabled (a billing lock
  blocks all runs). If runs fail with `startup_failure` / "account locked", fix
  the billing issue at https://github.com/settings/billing first.

If `$ARGUMENTS` contains a version number or change notes, use them.
