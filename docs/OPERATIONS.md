# Synthetic startup and recovery configuration

Public examples use synthetic paths only. The installed operator profile is
private and is supplied at runtime; it is not copied over by this repository.

## Configuration contract

`ops/backup-three-hosts.py` accepts `--config PROFILE.json` or
`CONTEXTKEEP_OPS_CONFIG`. `ops/restore-snapshot.py` accepts the same profile.
The example profile in `ops/contextkeep-ops.example.json` is a shape-only
fixture and is not an inventory. A profile configures:

- the expected primary hostname;
- source repository, SQLite data directory and exact runtime release path;
- snapshot and runtime-kit directories; and
- synthetic/configured NAS and standby destinations.

With no profile, existing template defaults remain in force. Profile
validation happens before the backup directory, lock, archive or restore
target is changed. A hostname, data path or runtime-release mismatch fails
closed. `--dry-run` validates identity and archive/runtime compatibility
without invoking a writer; `--report-space` reports retained runtime-kit
count/bytes and filesystem capacity. Neither option deletes snapshots or
kits.

The normal backup still retains snapshots and kits, records references from a
snapshot manifest to its runtime kit, verifies hashes and SQLite integrity,
and publishes the existing online-backup status contract. When an explicit
profile is used, the active private profile is also archived as the safe
member `config/contextkeep-ops-profile.json`; an operator recovers it by
extracting that member into a protected location, reviewing it, and passing
it deliberately to the backup/restore command. It is not a public config or
a license to overwrite installed operational scripts. A runtime kit may live
in a separate configured directory; the manifest reference and matching
release are still required for restore. Runtime kits are retained without
automatic deletion. Snapshot retention is unchanged: 96 recent snapshots plus
30 daily snapshots; older timestamped snapshots outside that existing policy
are pruned. This release introduces no additional cleanup policy.

Adoption is an operator change: create and review the private profile, run a
synthetic dry-run, then update the installed service arguments deliberately.
Do not blindly overwrite an installed operational script or profile.

## Startup and recovery invariants

Startup claims the single-primary writer before migrations or recovery. A
restore validates the complete archive namespace, manifest hash/counts,
release identity and database integrity before the configured restore CLI can
mutate the target. A live target additionally requires a known stopped or
failed service state. Failed verification is not reported as a successful
restore.

Runtime identity remains explicit: the source revision, release directory,
interpreter, `CK_DATA_DIR` and open database inode must agree. Backup/restore
does not promote a standby, delete an old kit, or silently select a different
runtime.
