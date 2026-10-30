# GitKroken

A desktop Git client with a GitKraken-style interface, built with Electron, React and TypeScript. It runs the `git` already installed on your computer, so everything it does is plain Git underneath.

![GitKroken main window](docs/images/main-window.png)

## Features

- **Commit graph** with coloured lanes, branch and tag labels, drag and drop of branches, and context menus for every action.
- **Staging area**: stage, unstage and discard whole files or single hunks; commit and amend.
- **Diff viewer** with VS Code (Dark+) syntax colours, in Hunk, Inline and Split views. Inline and Split show the whole file.
- **View all files** of any commit, and open any file exactly as it was in that commit.
- **Branches**: create, rename, delete, check out, merge, rebase, reset, cherry-pick, revert, tags and stashes.
- **Remotes**: fetch, pull and push (including force push with lease), with a credentials dialog, cancel and timeouts.
- **Conflict editor** to resolve merge, rebase and cherry-pick conflicts side by side.
- **Interactive rebase**: reorder, reword, squash, fixup and drop commits, with a backup of the original branch.
- **Undo / Redo** of commits, amends, branch switches, resets, merges, pulls, cherry-picks, reverts, rebases and branch renames.
- **History tools**: blame, file history (following renames) and commit search.
- **Submodules, worktrees and Git LFS**.
- **GitHub and GitLab**: list and create pull requests and issues; tokens are stored encrypted by the operating system.
- **Profiles** to switch the author name and email.

Safety comes first: operations that could lose work are guarded, confirmed or refused, and are covered by regression tests. The user manual has a section on [which actions can lose work](docs/USER_MANUAL.md#15-which-actions-can-lose-work).

## Requirements

- Node.js 20.11 or newer, npm 10
- `git` on the PATH
- Optional: `git-lfs`

Built and tested on macOS. Windows and Linux code paths exist but are untested.

## Getting started

```bash
npm install
npm run dev
```

| Command | Purpose |
|---|---|
| `npm run dev` | Run with hot reload |
| `npm run build` | Bundle the app into `out/` |
| `npm start` | Run the built app |
| `npm test` | Run the test suite (vitest) |
| `npm run typecheck` | Type-check the whole project |
| `npm run dist:mac` | Build the macOS app, a `.dmg` installer and a `.zip` in `dist/` (also `dist:win`, `dist:linux`) |

## Building an installable app

```bash
npm run dist:mac
```

This creates, in `dist/`:

- `GitKroken-<version>-arm64.dmg`: open it and drag **GitKroken** into **Applications**.
- `GitKroken-<version>-arm64-mac.zip`: the same app, zipped.
- `mac-arm64/GitKroken.app`: the app itself, ready to run.

The app is signed *ad hoc* (free, no Apple Developer account), so macOS does not know who made it. On a Mac that did not build it, the first launch is blocked: open **System Settings → Privacy & Security** and click **Open Anyway** (or right-click the app → **Open**). Distributing it without that step needs a paid Apple Developer ID and notarisation.

Windows (`npm run dist:win`, NSIS installer) and Linux (`npm run dist:linux`, AppImage) targets are configured but have not been tried.

## Documentation

- [User Manual](docs/USER_MANUAL.md): how to use every feature, for non-technical readers.
- [Technical Manual](docs/TECHNICAL_MANUAL.md): architecture, the Git backend, the safety model, tests, known risks, possible improvements and how to modify the app.

## Project layout

```
src/
  main/       Electron main process and the Git backend (src/main/git)
  preload/    The bridge between the window and the main process
  renderer/   The React interface
  shared/     Types shared by both sides (the GitApi contract)
docs/         Manuals and screenshots
```

## Status

Early version (0.1.0). The GitHub/GitLab features and pushing with real credentials through the app's dialog have not yet been verified against real accounts. See the [known risks and limitations](docs/TECHNICAL_MANUAL.md#12-known-risks-and-limitations).

GitKroken is an independent project and is not affiliated with GitKraken or Axosoft.
