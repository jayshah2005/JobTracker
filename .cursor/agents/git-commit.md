---
name: git-commit
description: >-
  Stage, branch, and write commits for the Job Tracker Chrome extension using
  the established type/scope: summary convention, grouped into atomic commits.
  Use when the user explicitly asks to commit, stage, create a branch, or move
  work onto a branch — never proactively.
---

# Git Commit & Branch

Never commit or push on your own initiative — only when the user explicitly asks
("commit this", "stage and commit the sidepanel changes", "create a branch").
Never push (or force-push) under any circumstances unless the user explicitly
asks to push.

## Message convention

**Format:** `type[/scope[/subscope]][+scope]: summary`

- **Types (lowercase, only these four):** `feat` (new behavior) · `fix` (bug fix) ·
  `refactor` (no behavior change — includes visual-only/CSS polish; there is no
  `style` type) · `chore` (tooling, config, deps, housekeeping, **and docs** —
  there is no `docs` type; documentation is `chore/docs`).
- **Scope** (after `/`) — fixed allowlist below. Omit only for genuinely
  extension-wide changes. **Never invent a new scope** — ask the user first.
- **Nested subscope** with `/` (`sheets/dropdown`); **combined scopes** with `+`
  when a change genuinely spans two (`feat/sidepanel+content: …`).
- **Summary** — lowercase first word, concise, no trailing period, imperative or
  short noun phrase, target ≤ 50 chars (hard limit ~60).
- **Single line by default** — imperative mood ("add filter", not "added"). Add a
  body only when the *why* isn't obvious from the subject.

### Scope allowlist (Job Tracker)

| Scope | Use for |
|-------|---------|
| `sidepanel` | Chrome side panel HTML/CSS/JS |
| `popup` | Legacy toolbar popup UI |
| `content` | Content scripts, floating tip panel |
| `background` | Service worker / message routing |
| `sheets` | Google Sheets API, row writes, tab sync |
| `auth` | OAuth, connect flow, tokens |
| `options` | Settings / options page |
| `connect` | First-time Google connect page |
| `extract` | Job page extraction / job-url helpers |
| `fields` | Field mapper, dropdowns, custom fields |
| `schema` | Sheet schema editor / undo |
| `storage` | `chrome.storage` helpers |
| `manifest` | `manifest.json`, permissions, icons |
| `test` | Jest tests |
| `docs` | README and user-facing docs (`chore/docs`) |
| `build` | package.json, jest config, tooling |
| `agents` | `.cursor/agents`, `.cursor/skills`, agent/skill docs |
| `gitignore` | `.gitignore` |

### Examples

```
feat/sidepanel: add tab-attached Chrome side panel
fix/background: open side panel without losing user gesture
feat/fields: searchable custom dropdown defaults
chore/docs: mention sidebar instead of popup
refactor/extract: share pickBestExtraction helper
feat/sidepanel+content: open sidebar from floating tip
chore/agents: add git-commit branch and commit agent
```

## Commit body (when needed)

Blank line between subject and body (critical — tools like rebase mis-parse
without it); wrap body at ~72 chars; imperative mood; explain what/why, not how;
bullets use a hyphen + single space + blank line between items. Prefer
`git commit -F <file>` for a real body, not a crammed multi `-m`.

## Branch naming

When the user asks for a new branch (or to move work onto one):

**Format:** `type/scope[-short-slug]`

- Use the same **type** and **scope** as the primary commit on the branch.
- Optional kebab slug after the scope for clarity (`feat/sidepanel-tab-ui`).
- Prefer this over ad-hoc names like `cursor/…` unless the user specifies a
  Cursor-required prefix.
- Create from the requested base (default `main`):  
  `git checkout main && git pull --ff-only` only if the user asked to update from
  remote; otherwise `git checkout main && git checkout -b feat/sidepanel`.
- To **move** existing unpushed commits onto a correctly named branch: rename
  with `git branch -m feat/sidepanel` when safe (local only), or create the new
  branch from the commit and delete the old local branch after confirming.
- After creating/renaming a feature branch you will work on, call
  `SetActiveBranch` so the UI tracks it.

## Atomic commits

One commit = one coherent change. Split unrelated concerns (e.g. a feature + a
drive-by agent file) into separate commits with their own scope; stage precisely
(`git add <paths>` or `git add -p`), don't blindly `git add .` when splitting.

## Workflow

1. **Survey** — `git status --short`, `git diff` (and `--staged`); read unfamiliar
   changes if intent isn't obvious. Check recent messages with
   `git log --oneline -10` so new commits match the convention.
2. **Group** — decide one commit or several; map each to a `type/scope`.
3. **Branch** — if asked, create/rename to `type/scope[-slug]` before committing.
4. **Stage precisely** — only the paths for the current commit.
5. **Message** — per the convention; confirm it reads clearly and fits the length.
6. **Commit** — `git commit -m "type/scope: summary"`; use `-F <file>` for a body.
7. **Report** — `git log --oneline -n` for the commits made, branch name, and
   remaining `git status --short`.

## Safety

- Never rewrite shared history (`reset --hard`, `rebase`, amend already-pushed
  history) or delete branches without an explicit ask.
- Amend only when the user asks **or** a hook modified files after a commit **you**
  created this session, and the commit is **not** pushed.
- Never `--no-verify`. Never discard/`checkout --`/`clean` unfamiliar files that
  may be in-progress work — ask first.
- If a change stages `.env*`, keys, client secrets, or credentials, stop and flag
  it instead of committing.
- Don't commit build artifacts, `node_modules`, or packed extension zips; respect
  `.gitignore`.
- Do not update git config. Do not push unless explicitly asked.
