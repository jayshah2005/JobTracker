---
name: keep-diagrams-updated
description: >-
  Keeps Mermaid architecture diagrams in diagrams/ accurate to the live Job
  Tracker codebase. Use whenever architecture changes (new/removed message
  types, background modules, content/sidepanel/options/connect flows, auth,
  Sheets orchestration, extraction/preload, storage keys), when finishing a
  feature that changes how the app works, before committing those changes, or
  when the user mentions diagrams, architecture docs, or diagrams/.
---

# Keep diagrams updated

Job Tracker’s how-it-works docs live in [`diagrams/`](../../../diagrams/).
They must match the code, not memory.

## When to run (mandatory)

After any change that affects **how the extension works**, update diagrams in
the **same turn** before you stop — do not wait for the user to ask.

Triggers include (not exhaustive):

- New/renamed/removed `chrome.runtime` message types
- New `background/*.js` module or a duty moved between modules
- Content / side panel / options / connect behavior changes
- Auth, Sheets, extract/preload, or storage-key changes
- Updates to [separation-of-duty](../separation-of-duty/SKILL.md) architecture map

Skip only for pure refactors with **identical** external behavior and message
surface (e.g. rename a private helper).

## Workflow

1. **Inventory truth from code** (prefer reading over recalling):
   - Message switch: `background/service-worker.js` + `background/side-panel.js`
   - Modules: `background/*.js` duty comments + imports
   - Surfaces: `content/`, `sidepanel/`, `options/`, `connect/`
   - Domain: `lib/` (extract, sheets-api, storage, duplicates, sheet-config, schema-editor)
   - Canonical map: [separation-of-duty](../separation-of-duty/SKILL.md)
2. **Diff against** every file under `diagrams/` (start with `architecture.md`).
3. **Patch diagrams** so nodes, edges, sequences, and storage keys match reality:
   - Fix wrong/missing layers, messages, and file names
   - Remove deleted paths; add new lasting paths
   - Keep Mermaid valid (no spaces in node IDs; quote labels with special chars)
4. **Preserve doc style**: numbered sections, short captions under diagrams,
   mental-model table if still useful. Same overall structure unless the app
   shape truly changed.
5. **If SoD map drifted**, update [separation-of-duty](../separation-of-duty/SKILL.md)
   in the same change (message allowlist + architecture table).
6. **Tell the user** which diagram sections you updated (one short line).

## Diagram conventions

- Location: `diagrams/*.md` — Mermaid in fenced `mermaid` blocks
- Primary doc: `diagrams/architecture.md`
- Prefer several focused diagrams (layers, detect→preload→panel, auth, save,
  sheets, storage) over one unreadable mega-graph
- Node labels may use `<br/>` for file paths / duties
- Do not document aspirational features — only shipped behavior
- Do not put secrets, tokens, or personal sheet IDs in diagrams

## Anti-patterns

- Shipping an architecture PR/commit without touching `diagrams/` when messages
  or module duties changed
- Duplicating full SoD prose into diagrams — diagram the flows; link SoD for
  ownership rules
- Inventing folders/message types that are not in the repo

## New diagram files

Add `diagrams/<topic>.md` only when a flow does not fit `architecture.md`
without clutter. Link it from `architecture.md` in one line. Prefer extending
`architecture.md` when possible.
