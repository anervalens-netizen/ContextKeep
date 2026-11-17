# Batch 7 — scoped MCP search candidate

Date: 2026-11-17

Status: **SOURCE CANDIDATE, PARTIAL V-13**

## Source-level behavior

The existing HTTP record search already filters by projectId, recordType and
inclusive UTC recordedAt date range. The MCP search_context tool previously
exposed projectId but not recordType or recordedFrom/recordedTo, despite
sharing the same backend. This candidate adds these optional parameters to
MCP without adding a query path or database index.

Each date is an ISO calendar date and filters the UTC date of recordedAt.
It does **not** filter sourceEventAt, effectiveFrom/effectiveTo, reviewedAt
or project import time. Invalid calendar dates, reversed bounds, unsupported
record types and undeclared **MCP** parameters fail explicitly. The existing
HTTP query schema may ignore undeclared keys; declared-filter selection parity
is the contract tested here.

Canonical accepted and working proposed reports remain separate arrays.
Historical accepted content remains opt-in and may include superseded data.
The existing compact and compatibility output modes, taskState provenance,
FTS/LIKE bounded candidates and completeness indicators are retained.
The old call without filters has the same default scope and response fields.

## Synthetic acceptance and limits

The source regression includes HTTP-versus-MCP parity for one project,
multiple record types, exact UTC boundary dates, canonical versus
unreviewed working rows, historical opt-in, different original event
and effective timestamps, and invalid/reversed filters. A read-only
before/after database fixture checks that no business records change.

The original tracker ME-13 covers additional taskId and source/excerpt
filters and broader date semantics. **Those features are not delivered by
this narrow source candidate.** V-13 stays PARTIAL until their scoped
behavior, pagination, redaction, source provenance and negative controls
are implemented and compared. No live rollout/latency claim follows from
the source-only change.
