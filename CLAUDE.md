<!-- dgc-policy-v11 -->
# Dual-Graph Context Policy

This project uses a local dual-graph MCP server for efficient context retrieval.

## MANDATORY: Adaptive graph_continue rule

**Call ``graph_continue`` ONLY when you do NOT already know the relevant files.**

### Call ``graph_continue`` when:
- This is the first message of a new task / conversation
- The task shifts to a completely different area of the codebase
- You need files you haven't read yet in this session

### SKIP ``graph_continue`` when:
- You already identified the relevant files earlier in this conversation
- You are doing follow-up work on files already read (verify, refactor, test, docs, cleanup, commit)
- The task is pure text (writing a commit message, summarising, explaining)

**If skipping, go directly to ``graph_read`` on the already-known ``file::symbol``.**

## When you DO call graph_continue

1. **If ``graph_continue`` returns ``needs_project=true``**: call ``graph_scan`` with ``pwd``. Do NOT ask the user.

2. **If ``graph_continue`` returns ``skip=true``**: fewer than 5 files  -  read only specifically named files.

3. **Read ``recommended_files``** using ``graph_read``.
   - Always use ``file::symbol`` notation (e.g. ``src/auth.ts::handleLogin``)  -  never read whole files.
   - ``recommended_files`` entries that already contain ``::`` must be passed verbatim.

4. **Obey confidence caps:**
   - ``confidence=high`` -> Stop. Do NOT grep or explore further.
   - ``confidence=medium`` -> ``fallback_rg`` at most ``max_supplementary_greps`` times, then ``graph_read`` at most ``max_supplementary_files`` more symbols. Stop.
   - ``confidence=low`` -> same as medium. Stop.

## Session State (compact, update after every turn)

Maintain a short JSON block in your working memory. Update it after each turn:

``````json
{
  "files_identified": ["path/to/file.py"],
  "symbols_changed": ["module::function"],
  "fix_applied": true,
  "features_added": ["description"],
  "open_issues": ["one-line note"]
}
``````

Use this state  -  not prose summaries  -  to remember what's been done across turns.

## Token Usage

A ``token-counter`` MCP is available for tracking live token usage.

- Before reading a large file: ``count_tokens({text: "<content>"})`` to check cost first.
- To show running session cost: ``get_session_stats()``
- To log completed task: ``log_usage({input_tokens: N, output_tokens: N, description: "task"})``

## Rules

- Do NOT use ``rg``, ``grep``, or bash file exploration before calling ``graph_continue`` (when required).
- Do NOT do broad/recursive exploration at any confidence level.
- ``max_supplementary_greps`` and ``max_supplementary_files`` are hard caps  -  never exceed them.
- Do NOT call ``graph_continue`` more than once per turn.
- Always use ``file::symbol`` notation with ``graph_read``  -  never bare filenames.
- After edits, call ``graph_register_edit`` with changed files using ``file::symbol`` notation.

## Context Store

Whenever you make a decision, identify a task, note a next step, fact, or blocker during a conversation, append it to ``.dual-graph/context-store.json``.

**Entry format:**
``````json
{"type": "decision|task|next|fact|blocker", "content": "one sentence max 15 words", "tags": ["topic"], "files": ["relevant/file.ts"], "date": "YYYY-MM-DD"}
``````

**To append:** Read the file -> add the new entry to the array -> Write it back -> call ``graph_register_edit`` on ``.dual-graph/context-store.json``.

**Rules:**
- Only log things worth remembering across sessions (not every minor detail)
- ``content`` must be under 15 words
- ``files`` lists the files this decision/task relates to (can be empty)
- Log immediately when the item arises  -  not at session end

## Session End

When the user signals they are done (e.g. "bye", "done", "wrap up", "end session"), proactively update ``CONTEXT.md`` in the project root with:
- **Current Task**: one sentence on what was being worked on
- **Key Decisions**: bullet list, max 3 items
- **Next Steps**: bullet list, max 3 items

Keep ``CONTEXT.md`` under 20 lines total. Do NOT summarize the full conversation  -  only what's needed to resume next session.

# Release SOP: the app must open (check every release)

Desktop v1.0.90 and v1.0.91 never opened a window. `setup.mjs` imported a new file (`lib/profiles-merge.mjs`) that `desktop/scripts/prepare.mjs` did not copy into the app. Start-up stopped before the window and the auto-updater, so every stuck laptop had to reinstall by hand. Do all of these before pushing a release tag.

## Desktop (`desktop-v*` tag)
1. A new or renamed file under `netlify/lib` or `netlify/functions` that `setup` / `verify` / `pay` / `prints` / `app` imports must also be copied by `copyServer` in `desktop/scripts/prepare.mjs`. `prepare.mjs` now fails the build when a copied file imports one that wasn't copied. Never remove or skip that check.
2. Build: `cd desktop && npm run dist:win`.
3. Start-up check, required: `powershell -ExecutionPolicy Bypass -File scripts\smoke-test.ps1` (from `desktop/`). It must print `PASS`. On `FAIL`, do not tag: fix it and build again. The script refuses to run while photobooth4u is open. Ask the user before closing a booth that may be in use.
4. Release only finished work. If the working tree has unfinished changes, `git stash push -- <those files>` first, build and check the release from the clean tree, then `git stash pop`.
5. After the GitHub Actions run, check that the release has all 3 installers and that `https://photobooth4u.netlify.app/api/updates` reports the new `app.version`.
6. Mac builds can't be checked on this laptop. Say so in the summary to the user, and ask them to open the `.dmg` build on a Mac if the release touched start-up code (`main.mjs`, `preload.cjs`, `lib/`, `prepare.mjs`).

## Website and Android (`android-v*` tag)
- After a Netlify deploy: `/` returns 200, and `POST /api/setup` returns 401, not 5xx. A 5xx means a server function fails to load.
- Before an Android tag: run `npm run build` so `android/app/src/main/assets/booth.html` matches `protected/booth.html`. The tablet uses that copy when offline. If a tablet is connected (`adb devices`), install the APK, open it online, then with Wi-Fi off.

## If the app won't open on a client's laptop
A stuck copy keeps running with no window, and new launches give way to it. Tell them to End task on photobooth4u in Task Manager (or restart), then install the fixed version from `/downloads`. Their licence code, settings and photos are kept (they are stored in `%APPDATA%\photobooth4u`). To see the start-up error on this laptop, close the app, set `ELECTRON_ENABLE_LOGGING=1` and start the exe with stderr redirected to a file.
