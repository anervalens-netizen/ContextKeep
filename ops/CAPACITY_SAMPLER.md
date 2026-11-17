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
at a stable private system path; configure
CK_CAPACITY_DB=/absolute/path/to/actual/store.sqlite in host-private
/etc/default/contextkeep-capacity-sample; instantiate
the supplied systemd timer unit template for the existing service user.
The sample unit runs unprivileged and read-only with no network activity.
Do not configure this on a passive standby or conflicting writer.

Local synthetic verification:
    python3 -B -m unittest ops/test_capacity_sample.py -v

Live acceptance needs at least two actual scheduled journal entries from
different times, the same runtime/database identity, and independent
backup/restore integrity. Trend conclusions require representative days and
separate write/lock workloads in an isolated fixture. Check journal retention
before selecting a comparison window.
