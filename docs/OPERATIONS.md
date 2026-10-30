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
target is changed. An explicitly selected profile must provide every
`PATH_FIELDS` value plus `primary_host` and `dell_target`; only
`runtime_release_name` is optional. A hostname, data path or runtime-release
mismatch fails closed. `dell_target` supports an ordinary `user@hostname` or
IP and SSH-config alias, without a port or other transport syntax.
`--dry-run` validates identity and archive/runtime compatibility without
invoking a writer; `--report-space` reports retained runtime-kit count/bytes
and filesystem capacity. Neither option deletes snapshots or kits.

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

## Private metrics scraping

Set an independent `CK_METRICS_TOKEN` of 32–256 characters in the private
service environment to enable `GET /metrics`. This bearer grants access only
to aggregate Prometheus metrics; it cannot access owner APIs or MCP tools.
The endpoint fails closed when unset and rejects cookie-only authentication,
URL credentials and browser origins. Existing owner-authenticated
`GET /api/metrics` remains available. Keep the scrape route on private
transport and store the credential in a protected file, never in the URL.
Startup rejects reuse of the MCP token or session secret for scraping.

An existing Prometheus installation can use `metrics_path: /metrics` and
`authorization.credentials_file` with a privately configured target. Validate
configuration before reload, then verify `up` and real
`ck_mcp_tool_calls_total` samples after MCP traffic. Retention determines the
available comparison window; enabling scraping does not backfill history.
Keep task, run, user and request IDs, arguments and result text out of labels.

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

## Passive backup versus takeover readiness

A hash-verified snapshot and matching runtime kit establish recoverability, not
that a standby's existing service symlink is current. A restored application
started with the bundled matching runtime is stronger evidence than copying the
archive. Physical failover and upstream authentication/routing remain separate
checks. Never start a passive standby just to make its status green while the
primary remains writable.

Before a schema upgrade retain the pre-upgrade snapshot and runtime kit. After
qualification deploy the exact immutable artifacts, verify schema/runtime identity
and authenticated readiness, then create new matching recovery copies. A binary
rollback alone cannot downgrade a migrated database. Operational profiles and
restore/deploy receipts remain private; these instructions do not authorize
replacing an installed profile with a repository template.

## Operational retention

Generic proposal retention never archives task identities, structured memory
(including unknown or malformed metadata), explicit task state, or records
referenced by workflow tables. This includes closed tasks, historical evidence,
verification receipts and paused projects. Accepted truth and owner declarations
retain their existing protection. Resolving a blocker does not make its
checkpoint eligible for generic retention.

Inspect one read-only page without starting the server or running migrations:

```sh
node --import ./apps/server/node_modules/tsx/dist/esm/index.mjs \\
  apps/server/src/cli/housekeeping-preview.ts \\
  --db /path/to/existing/store.sqlite --days 30 --limit 100
```

Follow `nextCursor` using `--cursor`; keep the same `--days`. Counts are per
page, not whole-database totals. The cursor preserves the observation cutoff;
revisions are read fresh on each page. Optional `--at` accepts an ISO timestamp
for isolated future-date qualification. Never apply simulated future retention
to production. Preview uses an existing SQLite file opened read-only and does
not load environment configuration, bootstrap a schema or run background jobs.
It holds the normal shared directory lease until the connection closes, so an
exclusive restore cannot move the store or sidecars underneath the preview.
The permanent coordination lock may be initialized; application data remains
read-only.
Application retention rechecks revision and current workflow references inside
the write transaction; preview is not an authorization to archive a stale row.

Operators can suspend automatic housekeeping with
`CK_HOUSEKEEPING_INTERVAL_MINUTES=0`. Verify the effective process setting:
a later environment file can override a service-level Environment directive.
Changing the interval does not disable backups or manual housekeeping, which
uses the same protective policy. Restore the chosen interval only after
qualifying the policy and verifying the running release and database identity.


## Compact three-host retention

The operator may install `ops/contextkeep-minimal-retention.py` as the post-backup
hook for a compact policy: four recent snapshots plus one daily snapshot for
three prior days on the primary and standby. The NAS keeps one verified snapshot
and its matching runtime archive. Each retained snapshot and referenced runtime
must pass its hash checks before the hook deletes older generations. A dry run
reports the proposed changes without removing archives.

Install the helper under the configured operator home on both hosts. Configure
an `ExecStartPost` with `--orchestrate --config <private-profile> --json` in the
backup user service. The profile supplies the real paths and hosts; do not commit
it. The backup archive includes the installed helper and drop-in so the effective
policy can be recovered. Without this optional hook, the base primary/standby
policy remains 96 recent and 30 daily snapshots; the published final status names
the policy actually applied. Keep the helper, backup script and recovery kit in
sync when deploying operational changes.

Validate with `python3 ops/contextkeep-minimal-retention.py --self-test` and the
operational recovery suite. A retention test is not a full application restore.

### Optional owner single sign-on

Local owner password login remains available. To add OpenID Connect, configure
all of `CK_OIDC_ISSUER`, `CK_OIDC_CLIENT_ID`, `CK_OIDC_CLIENT_SECRET`,
`CK_OIDC_OWNER_SUBJECT` and `CK_OIDC_CALLBACK_URL` privately. The issuer and
callback must use HTTPS, with secure cookies enabled. Register the exact
callback path `/api/auth/oidc/callback` as a strict redirect URI on a confidential
client with a signing key and the `openid` scope. `CK_OIDC_OWNER_SUBJECT` must be
the owner's exact, stable `sub` claim for this provider, not an email, role or a
claim inferred from an unverified token. All other subjects are refused.

Complete local owner setup first. The sign-in page then offers a top-level SSO
link, including when the application is embedded. The provider can reuse its
existing browser session. The callback creates the normal ContextKeep session
and CSRF cookies; provider tokens are not stored. `CK_OIDC_RETURN_URL` defaults
to `/`; operators may set a fixed HTTPS application URL for returning to a shell.
No request parameter controls this destination.

Each authorization attempt has PKCE, state, nonce and a five-minute HttpOnly
browser binding. Attempts are single-use and held in bounded server memory;
restarting the server invalidates incomplete sign-ins. Signed ID tokens are
validated against the provider's published keys. Session lifetime and logout
remain the same as local password sessions. ContextKeep logout does not sign out
other applications at the identity provider. Removing the OIDC configuration
hides the SSO link and leaves local owner login available.
