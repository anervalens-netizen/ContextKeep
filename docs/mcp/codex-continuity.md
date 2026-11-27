# Codex continuity with the existing ContextKeep workflows

This integration addresses the consumer side of ME-31 and ME-41. It gives Codex
a small instruction entry point and makes the existing `resume-work` procedure
explicit about fresh conversations, task switches and restored/compacted
context. ContextKeep remains the project/task memory and execution receipts stay
with the existing executor. There is no new memory store, scheduler or model API
integration.

## Scope and limits

The [versioned AGENTS fragment](codex-continuity-agents.md) selects the existing
workflow. The workflow performs bounded reads of the actual task and keeps
accepted knowledge, proposed reports, effective state and execution evidence
separate. A current scoped resume can be reused within the same recovery;
ordinary messages do not trigger a new full read.

This is instruction-based integration. It does not guarantee that every model
turn calls a tool. A compacted conversation may retain incomplete context, and
the client may not expose the compaction event to the model. Missing task
identity or uncertain state is therefore also a recovery trigger. Installation,
model-visible instructions, actual tool use and useful resumption must be
verified separately.

The local Codex profile and the connected ChatGPT/plugin surface are distinct.
Updating the packaged workflow makes the procedure available to supported
hosts; it does not install local AGENTS instructions on every machine. A server
publishing MCP skills does not prove the host imports them. See
[workflow publication](workflow-skills.md).

No native hook is installed. Local hooks have their own trust/review lifecycle
and client coverage, which would add another integration to maintain. Do not
edit a hook trust database or bypass review to make continuity appear automatic.

## Install in an existing Codex profile

Use the source from the qualified release. The helper supports POSIX systems
with Python 3. It defaults to `CODEX_HOME`, or `~/.codex` when that variable is
unset. Use an explicit profile path when more than one exists.

```sh
python3 ops/codex-continuity.py check --codex-home /path/to/codex-profile
python3 ops/codex-continuity.py install --codex-home /path/to/codex-profile
python3 ops/codex-continuity.py check --codex-home /path/to/codex-profile
```

`check` is read-only: exit 0 means the managed block matches the source, 1
means missing/outdated, and 2 means an inspection error. It does not claim the
host loaded the file. `install` adds or replaces only the block between
`contextkeep-continuity` markers. It preserves surrounding bytes and the
existing file mode; new files and backups are private to the profile owner.

Before replacement the helper saves the original file in the same profile,
uses a cooperating-installer lock, checks the original identity/content again,
and atomically replaces the file. Do not edit AGENTS.md concurrently: the final
check catches observed changes but cannot lock out unrelated editors. Keep the
reported backup until installation is verified. Backup files may contain owner
instructions and must stay private.

Malformed/duplicate markers, non-UTF-8 text, oversized files, linked/non-regular
targets and a non-empty global `AGENTS.override.md` stop installation. Reconcile
the effective instruction source explicitly; the helper never deletes an
override. It does not change config, account credentials, plugin caches,
project-level instructions or provider memory.

Start a new Codex conversation after an instruction or plugin update. Existing
sessions may retain their original instructions.

## Verify the behavior

Retain the candidate revision, client version, profile, plugin release, exact
task identities and bounded raw receipts privately. Use read-only task probes
and inspect the tools actually called, not only the final prose.

| Layer | Acceptance |
| --- | --- |
| Installer | Run `python3 -m unittest discover -s ops -p 'test_codex_continuity.py' -v`. Owner text, private backups, idempotence, removal, malformed markers, linked targets, override precedence, concurrent edits and failed replacement are covered. |
| Published procedure | Existing `workflow-skills.test.ts` must retain all six skill identities and verify get/read bytes, immutable manifests and hashes. |
| Native loading | In the intended profile, run `codex debug prompt-input` from two representative working directories. Verify the managed instructions and intended project instructions are present and not truncated. This diagnostic does not call a model and is not a behavior test. |
| Fresh conversation | Ask to continue a known existing task without naming a skill. Observe a bounded scoped `resume_task` (or equivalent supported contract), current state, next action and limits before any effects. |
| Task switch | In the same conversation switch to a second known task. Observe the second task's identity/state and no carry-over of the first task's action, blockers or receipts. |
| Restored context | Resume a separate conversation or explicitly compact a controlled thread. Observe a fresh scoped recovery before substantial work. Record which event was exercised; a fresh-session test is not compaction proof. |
| Failure/provenance | Use the separate synthetic agent cohort for cleared next action, unresolved execution and proposed-completion cases. This tests reasoning from fixed evidence, not live retrieval or instruction loading. |

Before a live probe, bound the model calls and use a read-only task: no task
creation, capture, job launch, acceptance, blocker resolution or lifecycle change
belongs in that probe. If a compact/resume behavior cannot be exercised on the
current host, record it as unverified rather than inferring success from loading.

For a real memory miss, preserve the natural query and scoped expected evidence
privately before changing aliases or prompts. Add a wholly synthetic regression
to the existing evaluation harness. Broad search saturation requires narrower
task/project scope or targeted source reads; it does not justify claiming a
missing fact was recovered. Source excerpts remain distinct evidence with
their own versions and provenance.

## Publish the existing owned plugin

The generic sources under `plugins/contextkeep-workflows` mirror the existing
owned package. Do not create a second plugin or edit installed cache files.

For an eligible account-managed package, use the plugin source reader to resolve
the exact backend identity, current release and complete inventory. Compare the
changed skill/reference bytes with the current release. Bump the manifest's
semantic version and any existing compatibility overlay while preserving the
connection, App IDs, presentation/default prompts, assets, audience and all six
skills. Upload only changed files and manifest at their original relative paths,
guarded by the observed expected release ID. Omitted assets remain intact.
Read back the new release and affected source, then verify the host separately.

If the package is managed by another source/release system, use that owning
release workflow. A saved plugin release is not evidence that an already-open
Codex session refreshed it.

## Remove or recover

```sh
python3 ops/codex-continuity.py remove --codex-home /path/to/codex-profile
```

Removal deletes only the managed block, preserving other content and backing up
the prior file. Separator whitespace added at first installation can remain.
For an exact rollback, compare the reported backup with any later owner edits
and restore through the normal owner workflow; never overwrite unrelated edits
blindly. Removing the block does not uninstall the plugin or delete ContextKeep
records.

## Primary references

- [Codex AGENTS.md configuration](https://developers.openai.com/codex/guides/agents-md)
- [Codex hooks and client support](https://developers.openai.com/codex/hooks)
- [Memory consumer plan](../plans/2026-11-16-memory-evolution/PLAN.md#56-use-existing-continuity-and-build-derived-knowledge-carefully)
