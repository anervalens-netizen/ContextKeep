# Optional SQLite capacity observer

The hourly observer collects **read-only** SQLite main/WAL/SHM sizes, page
counts and free pages, optional dbstat index bytes, and backing filesystem
reserve. Each successful sample emits one CK_CAPACITY_METRIC JSON event
to the host's private systemd journal. Failed reads emit only a generic
CK_CAPACITY_ERROR and fail nonzero. No records, project/client identities,
requests, credentials or database paths enter the event.

This provides longitudinal observations for ME-48 and does **not** checkpoint
WAL, rewrite the database, perform synthetic writes, add a metrics server, or
prove lock contention, query latency or a leak. A successful event is not a
service-health verdict. Failure/missing samples must remain visible.

The unit files in ops/systemd/ are templates, not enabled by checkout.
For a qualified single-primary installation, install the reviewed Python file
at the exact path /usr/local/libexec/contextkeep/capacity-sample.py
used by the supplied unit; configure
CK_CAPACITY_DB=/absolute/path/to/actual/store.sqlite in host-private
/etc/default/contextkeep-capacity-sample; instantiate
the supplied systemd timer unit template for the existing service user.
The supported command requires an **actually read-only mount namespace**.
SQLite mode=ro alone can still create/update WAL or SHM sidecars, so running the
Python entry point directly from a writable shell intentionally fails.
The sample acquires the **existing shared SQLite directory lease** before
opening the primary database and holds it through file-size observations;
exclusive restore blocks a sample. Missing lock database, invalid path or
locked restore fails closed. The systemd template runs unprivileged with
ProtectSystem=strict, IPAddressDeny=any and RestrictAddressFamilies=AF_UNIX.
Verify sandbox mount flags and real WAL sidecar immutability in a live test.

When a **stopped WAL primary** has no shared-memory sidecar, the hardened
read-only namespace may refuse to open SQLite. In that case, a file-only
observation reports main/WAL/SHM file sizes and free space but sets logical
page, index and journal-mode values to null, with observation=file_only;
this is **not** a successful SQLite integrity check. Busy/locked restores
must still fail without an event. An index dbstat scan is performed only
when the logical store is at most 256 MiB; larger databases retain exact
file/page sizes but index_bytes=null with index_measurement explicitly
skipped_large_database. This bounds the shared-lock holding time; it does
not measure write-lock contention or query latency.
Do not enable on a passive standby or while restoring a non-cooperating legacy
database without further review.

Local synthetic verification:
    python3 -B -m unittest ops/test_capacity_sample.py -v

Live acceptance needs at least two actual scheduled journal entries from
different times, the same runtime/database identity, and independent
backup/restore integrity. Trend conclusions require representative days and
separate write/lock workloads in an isolated fixture. Check journal retention
before selecting a comparison window.
