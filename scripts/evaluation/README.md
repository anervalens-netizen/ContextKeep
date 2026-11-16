# Private corpus preflight

This is an offline helper for the existing ContextKeep baseline protocol. It validates a private corpus before freezing its identity and reports JSON serialization sizes from an already captured MCP result. It does not call services, execute tools, retrieve memories, or score agent answers.

This package contains no natural corpus. The tests construct explicitly synthetic fixtures only. A passing synthetic test suite is not evidence of retrieval quality, production behavior, or an independently reviewed natural corpus.

## Protocol identity

- Source commit: `6cc120a06233ffa08a1c0139b5fe5a6015109ded`.
- File: `docs/plans/2026-11-16-memory-evolution/BASELINE_PROTOCOL.md`.
- Exact Git file size: 24,322 bytes.
- SHA-256: `3f7e7220a810296e15712561861f00f340c9285dfde3ea9c38e631d5a318e783`.
- Git blob: `31910194e73cbca60bb10ad6ae1d24bfbe73c86a`.

The digest identifies the actual Git file, including its original newline bytes. It is not the digest of a connector-rendered text copy. The test asserts this pinned identity and, when installed at `scripts/evaluation`, also hashes the repository protocol file.

## Commands

Use Python 3.10 or later. There are no third-party dependencies.

```sh
python private_eval.py validate /private/corpus.json --evidence-root /private/evidence
python private_eval.py freeze /private/corpus.json --evidence-root /private/evidence --out /private/frozen-v1.json
python private_eval.py measure /private/captured-mcp-result.json
python -m unittest -q test_private_eval.py
```

`validate` returns `READY` only for the structural and evidence conditions this helper can check. Invalid or incomplete input returns `BLOCKED` and exit code 2. Malformed nested input is blocked instead of escaping as a traceback. `READY` does not certify that a reviewer has made a correct semantic judgment.

`freeze` requires a complete `private_natural` corpus and an explicit `--out`. It writes the full corpus once to a new file with mode `0600`; existing files are never overwritten. Standard output contains only a receipt with hashes and the case count. Synthetic fixtures cannot be frozen as a natural corpus.

`measure` accepts a full captured MCP result. It can print or save a summary. Do not run it on the capture wrapper described below: its input is that wrapper's `result` value. All input files are bounded to 2 MiB, including reads when a file grows after its initial size check. Keep private input and output outside the public repository and general-purpose CI logs.

## Required corpus and evidence

The executable schema example is `complete_synthetic_fixture` in `test_private_eval.py`. Its generated examples are test data, not proposed natural questions. The top-level corpus fields are `schemaVersion`, `kind`, `version`, `protocol`, `manifest`, `splitReview`, `evidence`, and `cases`.

The preflight requires exactly 40 cases: 20 development and 20 held-out, 20 Romanian and 20 English, and four cases in each of the protocol's ten groups. Each group contains two distinct episodes, each a Romanian/English pair; one episode belongs to each split. The corpus needs at least six explicit abstention cases and eight operational task-state cases. Known audit regressions cannot be marked as independent held-out cases.

Each case declares the intended task, read-only tool contract, temporal semantics, expected record/source/task identities, response and task-state oracles, eligible measurements, and reviewed evidence references. Unknown pointers and timestamps must remain explicit. Missing ground truth is not replaced with an invented expected answer.

The manifest binds source, runtime, shared artifact, schema, client, dirty paths, requested UTC window, fixture clock, capture method, and broader-baseline status. Source/runtime differences require an explanation. The split review records the reviewer, review time, episode separation, prior exposure, and freeze-before-tuning attestation.

Each evidence entry maps to a relative JSON path and SHA-256. The captured JSON has this shape:

```json
{
  "kind": "private_capture",
  "tool": "get_record",
  "arguments": {"recordId": "ACTUAL_PRIVATE_ID"},
  "capturedAt": "UTC_CAPTURE_TIME",
  "complete": true,
  "result": {"structuredContent": {"id": "ACTUAL_PRIVATE_ID"}}
}
```

The placeholders above deliberately do not form valid ground truth. Supply the actual complete MCP envelope, retaining its `content`, `structuredContent`, `isError`, and any completeness indicators. A `complete: true` wrapper cannot promote an error, an explicitly incomplete/truncated result, or an absent response identity into gold evidence. Expected identities are checked against the response payload; request arguments and wrapper metadata are not positive identity evidence.

Truncation checks include nested evidence excerpts such as `evidence[].textTruncated` and the search response's `completeness` branches with `mayHaveMore` or `candidateLimitReached`. These captures can be valid search observations but cannot serve as complete ground-truth evidence. Nested domain records with a field named `error` remain data; only the MCP envelope and root tool payload are inspected for tool errors.

Verification cannot precede the referenced capture. A freeze cannot precede captures or ground-truth/split reviews. The validator checks shared episode keys, questions, expected identities, capture identities/hashes, and capture targets across splits. Independent review must still establish semantic correctness and detect concealed overlap. Hashes establish byte identity, not truth, completeness of history, or genuine reviewer independence.

## Measurement limits

`logicalStructuredChars` counts Unicode code points and is labeled with `charUnit: unicode_code_points`. `logicalStructuredUtf16Units` separately measures the UTF-16 code units used by JavaScript string length. `logicalStructuredUtf8Bytes` is the compact canonical structured JSON encoded as UTF-8. An emoji therefore need not have the same count in all three units.

`completeSerializedMcpResultUtf8Bytes` serializes the complete captured MCP result once, including both textual and structured representations when present. It is not the original HTTP wire size. Missing logical payloads produce `null`, not a fabricated zero-byte successful response. Tool errors and omission indicators remain diagnostic fields.

Retrieval quality, abstention correctness, and agent usefulness remain `NOT_RUN`. Provider token counts and cost remain `null`. The helper does not create a second Recall implementation, infer billing from characters, measure live latency, or declare the broader usage/population baseline complete. Use existing ContextKeep evaluators for their established synthetic retrieval checks.

## Integration and remaining work

This directory contains the generic helper, documentation and wholly synthetic tests. Run the repository command `pnpm test:private-corpus`, or use Python directly:

```sh
python -m unittest discover -s scripts/evaluation -p 'test_private_eval.py' -q
```

Private questions, expected identities, capture artifacts, frozen corpus files, and private checkpoints must stay outside Git. Existing synthetic retrieval fixtures, held-out cases, scoring rules, and quality floors remain unchanged.

To prepare a real corpus, obtain bounded fresh evidence reads under its task; select real episodes without reusing audit failures as held-out examples; independently review the identities, time semantics, abstention reasons, and split; then freeze before candidate tuning. Do not create a new database snapshot or run a mass query benchmark to populate this helper.

The helper is covered by synthetic guard tests. A successful natural-corpus freeze and live measurement require separate qualification with private evidence. The successful CLI privacy path is tested with a controlled synthetic freezer result, while the real freezer rejects synthetic corpora.
