# Job Tracker — instructions for Claude

## Git: ask before every commit, push, or PR
- **Never** run `git commit`, `git push`, or `gh pr create` unless the user explicitly asks or tells you to, for that specific action.
- Completing work, green tests, or an earlier go-ahead is not permission. Finish the edits, report, then ask.
- Before any approved commit, check `git branch --show-current`; never commit on `main`.
- Follow `.cursor/rules/git-commit.mdc` for message format and allowed scopes (never invent a scope).
