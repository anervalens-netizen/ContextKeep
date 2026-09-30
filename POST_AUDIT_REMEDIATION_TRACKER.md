# Post-audit integrity remediation

Issue: #5. Status: in progress. Earlier completed qualifications remain closed.

- [x] PFA-01 Later task closure/cancellation supersedes stale reported state, with explicit reopening controls.
- [x] PFA-02 Resume text includes current proof validity and actionable warnings.
- [x] PFA-03 UTC observations compare chronologically across fractional precision, including retained rows.
- [x] PFA-04 Authenticated readiness reads the real schema and validates required application objects.
- [x] PFA-05 Patch the build-only serializer dependency without unrelated upgrades.
- [x] Synthetic regression/control cases demonstrate failures before repairs and pass afterwards.
- [ ] Full release gate, external review, qualified immutable runtime and recovery copies.
- [ ] Synchronized source, final readback and closure.

No production data is used in fixtures. Operational receipts remain private.
Do not auto-accept reports, replay jobs, remove blockers, or impose blanket exit-code rules.

Evidence: the same 22 synthetic cases produced 16 expected failures and six passing
controls on the unchanged baseline; all 22 pass on the implementation. Type,
context, static and privacy checks passed. Full release qualification is running.

Next: finish the complete gate and external review; no deployment is claimed yet.
