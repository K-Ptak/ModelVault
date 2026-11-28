# Contributing to ModelVault

Thanks for taking the time to help! Bug reports, ideas, translations and code are all welcome.
This guide explains how the project is organised so your change can be merged quickly.

## Contents
- [Reporting bugs and suggesting features](#reporting-bugs-and-suggesting-features)
- [Development setup](#development-setup)
- [Branch strategy](#branch-strategy)
- [Commit messages](#commit-messages)
- [Pull requests](#pull-requests)
- [Code guidelines](#code-guidelines)
- [Translations](#translations)
- [Tests](#tests)
- [Releases](#releases)

## Reporting bugs and suggesting features

Use [GitHub Issues](https://github.com/K-Ptak/ModelVault/issues) and pick the matching template.
For bugs, please include your OS, the ModelVault version (Settings → About) and, if possible,
the file that causes the problem — a damaged or unusual model file is often the fastest way to reproduce it.

## Development setup

Requirements: **Node.js 22+** and git. Windows, Linux and macOS all work for development.

```bash
git clone https://github.com/K-Ptak/ModelVault.git
cd ModelVault
git checkout dev
npm install        # also copies the needed three.js modules to renderer/vendor
npm start          # run the app
npm test           # run all tests
```

Useful environment variables for development:

| Variable | Purpose |
|---|---|
| `MV_USERDATA=/tmp/profile` | use a separate settings profile instead of your real one |
| `MV_ROOT=/path/to/library` | open a specific library folder on start |
| `MV_REAL_DIR=/path/to/models` | run extra tests against your own model files |

Building packages locally: `npm run dist:win`, `npm run dist:linux` or `npm run dist:mac` (output in `dist/`).
Each platform is normally built on its own OS; CI does all three for releases.

## Branch strategy

| Branch | Purpose | Who pushes |
|---|---|---|
| `main` | released code only; every release is a tag `vX.Y.Z` on `main` | merges from `dev` (and hotfixes) |
| `dev` | integration branch – the next release is assembled here | merged pull requests |
| `feature/<short-name>` | a new feature, e.g. `feature/print-calendar` | you |
| `fix/<short-name>` | a bug fix, e.g. `fix/purge-estimate` | you |
| `hotfix/<short-name>` | an urgent fix for the released version | maintainer |

```
feature/x ──┐
fix/y ──────┼──► dev ──(release PR)──► main ──► tag v1.2.0 ──► CI builds & publishes
            │                           ▲
hotfix/z ───┴───────────────────────────┘ (and merged back into dev)
```

1. Branch off **`dev`**: `git checkout dev && git pull && git checkout -b feature/my-change`.
2. Open a pull request **into `dev`**. Tests must pass before merging.
3. When `dev` is ready for a release, the maintainer opens a pull request `dev → main`, bumps the version and tags it.
4. Hotfixes branch off `main`, are merged into `main` (new patch version) and then merged back into `dev`.

`main` and `dev` are protected: no direct force-pushes or deletions, and the test workflow has to pass.

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/). The type tells at a glance what changed
and the release notes are grouped by it.

```
feat: print calendar with due date notifications
fix: purge was counted twice for sliced 3MF files
docs: describe the branch strategy
refactor: move pricing into its own module
test: cover damaged STL files
chore: update electron to 45.5
```

Use the imperative mood ("add", not "added"). Write the subject in English; the body can explain *why*.

## Pull requests

- Keep a pull request focused on one thing — smaller PRs get reviewed faster.
- Fill in the pull request template (what changed, how it was tested, screenshots for UI changes).
- Add a line to the `Unreleased` section of [CHANGELOG.md](CHANGELOG.md) for user-visible changes.
- Make sure `npm test` passes locally. CI runs the same tests on every push and pull request.

## Code guidelines

- Plain JavaScript (ES modules in the renderer, CommonJS in the main process), no build step.
- The renderer never touches the file system directly: everything goes through `window.api` (see `preload.js`).
- Pure logic (pricing, file parsing, printers, calendar) lives in small modules without DOM access, so it can be tested in Node.
- User files are never modified without an explicit action; deletions go to the system trash.
- Follow the existing style: 2-space indentation, single quotes, semicolons. Comments may be in Polish or English.

## Translations

The app is available in Polish, English and German.

- UI text is written **in Polish** in the source and wrapped in `T('…')`, e.g. `T('Zapisz')` or `T('Dodano {0} pliki', { 0: n })`.
- The Polish text is the key in `renderer/locales/en.js` and `renderer/locales/de.js` – add the English and German translation for every new text.
- Keep the `{0}`, `{1}` placeholders. Avoid building sentences out of fragments, and avoid Polish plural forms that depend on the number (write "Liczba plików: {0}" rather than "{0} plików").
- Static HTML uses `data-i18n`, `data-i18n-title` and `data-i18n-placeholder` attributes.
- `npm test` fails when a translation is missing or a placeholder doesn't match.

**Adding a language:** copy `en.js` to e.g. `fr.js`, translate the values and register the language in `renderer/i18n.js`
(`LANGS`, `DICTS`, `LOCALES`).

## Tests

Tests use the built-in `node:test` runner and live in `test/*.test.mjs`:

| File | Covers |
|---|---|
| `core.test.mjs` | pricing, slicer data, multicolour files, plate detection |
| `files.test.mjs` | empty, damaged, truncated and unsupported model files |
| `data.test.mjs` | corrupted settings/metadata recovery, ZIP safety |
| `printers.test.mjs` | printer library, AMS, build volume, batch capacity |
| `calendar.test.mjs` | calendar events and notification rules |
| `i18n.test.mjs` | completeness of translations |

New logic should come with tests. For UI changes, please attach screenshots to the pull request.

## Releases

Releases are made by the maintainer from `main`:

1. Merge `dev` into `main` and move the `Unreleased` changelog entries under the new version.
2. Set `version` in `package.json` ([semantic versioning](https://semver.org/): `1.0.1` fix, `1.1.0` feature, `2.0.0` breaking change).
3. `git tag v1.1.0 && git push origin v1.1.0`

GitHub Actions then runs the tests, builds Windows, Linux and macOS packages into a draft release and publishes it
once all three builds succeed.
