# Adversarial remediation tracker

Issue: #3. Status: implemented with focused regressions; full release gate in progress, not deployed.
The completed operational dossier qualification remains closed.

- [x] F01 explicit null next action and temporal regression matrix.
- [x] F02 generation-fenced responses and renewal/rotation regression matrix.
- [x] F03 bounded real event-pump drain before SQLite shutdown.
- [x] F04 paginated project refresh, error recovery and race regression tests.
- [x] F05 task-scoped blocker-resolution evidence and isolation tests.
- [x] V01 explicit run/evidence correlation with compatible capture API.
- [x] V02 current evidence validity separate from historical verdict.
- [x] Task-scoped delivery/continuation visibility and authenticated readiness.
- [x] README, architecture, MCP, recovery and operational contracts updated.
- [ ] Complete release gate and independent final review.
- [ ] Qualified immutable release and live read-only checks.
- [ ] Matching recovery copies and synchronized source.
- [ ] GitHub review threads checked and tracker closed.

Public tests and examples are synthetic. Deployment receipts and private data stay outside Git.
Do not mark production or review checks complete merely because code is implemented.

## Qualification evidence so far

The focused server selection passed 48 tests in seven files; the UI selection
passed eight tests in two files. A further accepted-task regression is included
in the full release gate. The normal suites now cover the originally reproduced
races, non-cooperating transport cancellation, retry after renewal, task-scoped
resolution, explicit evidence correlation, edits/retraction/restoration and
legacy verification. Typecheck and public-data checks passed before full tests.

Deployment and external review remain open. Do not interpret these source checks
as production completion. Detailed operational receipts are retained privately.

## Review follow-up

Five external review findings fixed locally: inspected proof snapshot; partial
prefix refresh; exact shutdown abort accounting; delivery lease revocation fence;
schema-19 recovery objects. Focused qualification: 51 server and five UI tests
passed. Complete qualification and deployment remain open.
