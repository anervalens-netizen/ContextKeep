# Adversarial remediation tracker

Issue: #3. Implementation: PR #4. Status: completed and recovery-qualified.
The earlier operational dossier qualification remains closed.

- [x] F01 explicit null next action and temporal/accepted-task regression matrix.
- [x] F02 generation- and delivery-lease-fenced responses with renewal/rotation controls.
- [x] F03 bounded real event-pump drain before SQLite shutdown; only actual cancellation refunds an attempt.
- [x] F04 paginated project refresh, partial-prefix publication, deduplication and error/race recovery.
- [x] F05 task-scoped blocker-resolution evidence and isolation tests.
- [x] V01 exact run/receipt correlation and immutable inspected-proof snapshot.
- [x] V02 current evidence validity separate from historical verdict, with explicit legacy handling.
- [x] Task-scoped delivery/continuation visibility and authenticated readiness.
- [x] README, architecture, MCP, evidence, recovery and operational contracts updated.
- [x] Complete release gate and final external review.
- [x] Qualified immutable release and live read-only checks.
- [x] Matching recovery copies and synchronized source.
- [x] Review comments addressed and closure recorded.

## Final qualification

Qualified source: `5a213aa73f92b35ce09b2e48c47ca26428231f05`.
Merged runtime: `c496cc840382e87aeb43eea233c4f759cda1c6d5`; its source tree is identical.

All ten release gates passed: 989 functional tests (12 shared, 667 server,
310 web), 68 operational tests, context/static/privacy checks, production build,
browser navigation/widget verification and dependency audit. All 430 compiled
artifacts matched between qualification and deployment-build hosts.

Five additional Codex findings were fixed with regression/control tests. The
final external rereview of the qualified commit reported no major issues.
Schema-18 to schema-19 migration was verified on an isolated recovery copy:
protected data counts unchanged, readable dossiers, valid SQLite integrity and
foreign keys, and strict version-specific backup validation.

MCP 2.13.0 and schema 19 were verified in the live runtime, including read-only
resume, exact build identity, the current v5 resource and retained v2/v3/v4
resource reads. Snapshot and runtime-kit hashes matched on three recovery
copies. An isolated restore from the NAS copy used its exact runtime kit and
bundled interpreter; the restored application, authenticated readiness, MCP,
evidence tables and data-integrity checks passed. The primary was not replaced
by the restore drill; standby remained inactive.

Public fixtures and examples are synthetic. Deployment-specific paths, data,
credentials, hashes of private backups and detailed receipts remain outside Git.
No closed pilot was restarted, legacy reports were not automatically accepted
or reassigned, and no second writable primary was enabled. This final tracker
update is closure-only documentation, not an undeployed application change.
