#!/usr/bin/env python3
"""Private, offline corpus preflight and JSON-size diagnostics. No tool execution."""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import unicodedata

PROTOCOL_COMMIT = "6cc120a06233ffa08a1c0139b5fe5a6015109ded"
PROTOCOL_SHA256 = "3f7e7220a810296e15712561861f00f340c9285dfde3ea9c38e631d5a318e783"
MAX_JSON_BYTES = 2 * 1024 * 1024
GROUPS = (
    "runtime_migration", "task_progress", "closure_followup", "authority_scope",
    "versioned_reviews", "source_only", "identifiers_recovery", "wording_aliases",
    "monitoring_dependencies", "unknown_coverage",
)
READ_TOOLS = frozenset({
    "search_context", "get_record", "get_task", "resume_task", "get_project",
    "get_project_brief", "get_project_dossier", "get_work_context", "get_source",
})
TRUNCATION_FLAGS = ("partial", "truncated", "textTruncated", "contentTruncated",
                    "structuredContentTruncated", "resultOmitted",
                    "supportReferencesTruncated", "possiblyRelatedReferencesTruncated",
                    "summaryTruncated", "outcomeTruncated", "nextActionTruncated",
                    "blockersTruncated", "nameTruncated", "budgetOmittedRecordIdsTruncated")
# Continuations returned by the allowed record/source, task and project reads.
CONTINUATION_FIELDS = ("nextOffset", "excerptNextOffset", "evidenceNextOffset",
                       "runsBlockersNextOffset", "activeNextOffset",
                       "resolvedNextOffset", "historyNextOffset")
TASK_FIELDS = frozenset({
    "taskId", "originalStatus", "effectiveState", "stateSource",
    "progressRecordId", "stateProvenanceRecordId", "recordReviewStatus",
    "progressReviewStatus", "progressEvidenceBasis", "resume",
})
SCORED = ("recordRecallAt5", "recordRecallAt10", "sourceRecallAt5", "sourceRecallAt10",
          "identityCurrentness", "taskState", "provenance", "presentation")


class Invalid(ValueError):
    pass


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
                      allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def _unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise Invalid("duplicate JSON key")
        result[key] = value
    return result


def loads(data):
    try:
        return json.loads(data, object_pairs_hook=_unique,
                          parse_constant=lambda value: (_ for _ in ()).throw(Invalid("nonfinite JSON")))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise Invalid("invalid UTF-8 JSON") from exc


def read_json(path):
    path = Path(path)
    if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_JSON_BYTES:
        raise Invalid("expected a bounded ordinary JSON file")
    with path.open("rb") as handle:
        raw = handle.read(MAX_JSON_BYTES + 1)
    if len(raw) > MAX_JSON_BYTES:
        raise Invalid("JSON file grew beyond size limit")
    return loads(raw)


def utc(value):
    if not isinstance(value, str):
        raise Invalid("UTC timestamp required")
    try:
        stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise Invalid("invalid timestamp") from exc
    if stamp.tzinfo is None or stamp.utcoffset().total_seconds() != 0:
        raise Invalid("timestamp must be explicit UTC")
    return stamp


def sha(value, length=64):
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{" + str(length) + "}", value) is not None


def nonempty(value):
    return isinstance(value, str) and bool(value.strip())


def string_list(value):
    return isinstance(value, list) and all(nonempty(x) for x in value) and len(value) == len(set(value))


def normalized(value):
    return " ".join(unicodedata.normalize("NFKC", value).casefold().split())


def artifact(root, ref):
    """Bound local artifacts to one evidence root; never follow symlink ancestors."""
    if not isinstance(ref, dict) or not sha(ref.get("sha256")):
        raise Invalid("artifact digest required")
    rel = PurePosixPath(ref.get("path", ""))
    if rel.is_absolute() or not rel.parts or any(x in {".", ".."} for x in rel.parts):
        raise Invalid("artifact must have a bounded relative path")
    root = Path(root).resolve(strict=True)
    candidate = root
    for part in rel.parts:
        candidate = candidate / part
        if candidate.is_symlink():
            raise Invalid("symlink artifact path rejected")
    info = candidate.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_JSON_BYTES or info.st_nlink != 1:
        raise Invalid("expected a bounded unaliased ordinary artifact")
    with candidate.open("rb") as handle:
        raw = handle.read(MAX_JSON_BYTES + 1)
    if len(raw) > MAX_JSON_BYTES or hashlib.sha256(raw).hexdigest() != ref["sha256"]:
        raise Invalid("artifact size/hash mismatch")
    return loads(raw)


def scalars(value):
    if isinstance(value, str):
        return {value}
    if isinstance(value, dict):
        return set().union(*(scalars(x) for x in value.values())) if value else set()
    if isinstance(value, list):
        return set().union(*(scalars(x) for x in value)) if value else set()
    return set()


def explicitly_incomplete(value, within_completeness=False):
    """Recognize response completeness flags; nested domain errors remain data."""
    if isinstance(value, dict):
        flags = TRUNCATION_FLAGS + (("mayHaveMore", "candidateLimitReached") if within_completeness else ())
        if any(flag in value and (type(value[flag]) is not bool or value[flag]) for flag in flags):
            return True
        if any(key in value and value[key] is not None for key in CONTINUATION_FIELDS):
            return True
        for parent, key, marker in (
            ("diagnostics", "reasons", "budget_omission"),
            ("indicators", "unknown", "context_budget_omitted_optional_content"),
        ):
            details = value.get(parent)
            if isinstance(details, dict) and isinstance(details.get(key), list) and marker in details[key]:
                return True
        return any(explicitly_incomplete(child, within_completeness or key == "completeness")
                   for key, child in value.items())
    if isinstance(value, list):
        return any(explicitly_incomplete(child, within_completeness) for child in value)
    return False


def case_hash(case):
    return digest(case)


def _validate(corpus, evidence_root):
    """Schema/identity checks. Attestations are checked, never invented by the validator."""
    errors = []

    def check(ok, code, location):
        if not ok:
            errors.append({"code": code, "location": location})

    if not isinstance(corpus, dict):
        return {"status": "BLOCKED", "errors": [{"code": "object_required", "location": "root"}]}
    kind = corpus.get("kind")
    check(kind in {"private_natural", "synthetic_test"}, "dataset_kind", "kind")
    check(corpus.get("schemaVersion") == 1 and nonempty(corpus.get("version")), "version", "root")
    check(corpus.get("protocol") == {"commit": PROTOCOL_COMMIT, "sha256": PROTOCOL_SHA256},
          "protocol_identity", "protocol")
    manifest = corpus.get("manifest", {})
    if not isinstance(manifest, dict):
        manifest = {}
    for key in ("capturedAt", "fixtureClock"):
        try:
            utc(manifest.get(key))
        except Invalid:
            check(False, "utc_timestamp", "manifest." + key)
    identity = manifest.get("identity", {})
    if not isinstance(identity, dict):
        identity = {}
    for key in ("sourceCommit", "runtimeBuildSha"):
        check(sha(identity.get(key), 40), "implementation_identity", "identity." + key)
    check(sha(identity.get("sharedArtifactSha256")), "artifact_identity", "identity.sharedArtifactSha256")
    check(type(identity.get("schemaVersion")) is int and identity["schemaVersion"] > 0,
          "schema_identity", "identity.schemaVersion")
    for key in ("mcpVersion", "clientVersion"):
        check(nonempty(identity.get(key)), "version_identity", "identity." + key)
    check(isinstance(identity.get("dirtyPaths"), list), "dirty_paths_required", "identity")
    if identity.get("dirtyPaths"):
        check(sha(identity.get("dirtyDiffSha256")), "dirty_diff_identity", "identity")
    if identity.get("sourceCommit") != identity.get("runtimeBuildSha"):
        check(nonempty(identity.get("discrepancyNotes")), "runtime_discrepancy_note", "identity")
    window = manifest.get("window", {})
    window_bounds = None
    try:
        start, end = utc(window["startInclusive"]), utc(window["endExclusive"])
        check(start < end, "window_order", "window")
        if start < end:
            window_bounds = start, end
        check(window.get("timeBasis") == "evidence_capture", "capture_window_basis", "window")
        check(nonempty(window.get("timezone")) and isinstance(window.get("missingPeriods"), list),
              "window_coverage", "window")
    except (Invalid, KeyError, TypeError):
        check(False, "window_boundary", "window")

    def capture_time(value, location):
        stamp = utc(value)
        if window_bounds is not None:
            check(window_bounds[0] <= stamp < window_bounds[1], "capture_outside_window", location)
        return stamp

    manifest_capture = None
    try:
        manifest_capture = capture_time(manifest.get("capturedAt"), "manifest.capturedAt")
    except Invalid:
        pass  # The timestamp error was already recorded above.
    method = manifest.get("method", {})
    check(isinstance(method, dict) and method.get("surface") == "mcp_captured_offline"
          and type(method.get("repetitions")) is int and 1 <= method["repetitions"] <= 30
          and type(method.get("warmupCount")) is int and method["warmupCount"] >= 0
          and nonempty(method.get("workloadNotes")) and nonempty(method.get("collectorVersion")),
          "measurement_contract", "manifest.method")
    check(manifest.get("broaderPopulationBaseline") in {"NOT_RUN", "BLOCKED", "PARTIAL", "VERIFIED"},
          "population_scope_required", "manifest")
    check(manifest.get("broaderUsageBaseline") in {"NOT_RUN", "BLOCKED", "PARTIAL", "VERIFIED"},
          "usage_scope_required", "manifest")
    review = corpus.get("splitReview", {})
    if not isinstance(review, dict):
        review = {}
    check(review.get("status") == "verified" and nonempty(review.get("verifier"))
          and review.get("semanticOverlapReviewed") is True
          and review.get("heldoutConsumed") is False
          and review.get("frozenBeforeCandidateTuning") is True,
          "independence_review_required", "splitReview")
    try:
        utc(review.get("verifiedAt"))
    except Invalid:
        check(False, "utc_timestamp", "splitReview.verifiedAt")

    evidence = corpus.get("evidence", {})
    loaded = {}
    loaded_payloads = {}
    if not isinstance(evidence, dict) or not evidence:
        check(False, "evidence_required", "evidence")
        evidence = {}
    for eid, ref in evidence.items():
        try:
            value = artifact(evidence_root, ref)
            expected_kind = "private_capture" if kind == "private_natural" else "synthetic_capture"
            if not isinstance(value, dict) or value.get("kind") != expected_kind:
                raise Invalid("capture origin does not match dataset")
            if value.get("tool") not in READ_TOOLS or not isinstance(value.get("arguments"), dict):
                raise Invalid("read-only capture required")
            observed_at = capture_time(value.get("capturedAt"), "evidence." + str(eid) + ".capturedAt")
            if manifest_capture is not None:
                check(manifest_capture >= observed_at, "manifest_capture_before_evidence", "evidence." + str(eid))
            if "result" not in value or value.get("complete") is not True:
                raise Invalid("incomplete ground-truth capture")
            result = value["result"]
            body = payload(result)
            for envelope in (result, body):
                if any(flag in envelope and type(envelope[flag]) is not bool for flag in ("isError", "complete")):
                    raise Invalid("malformed MCP error/completion flag")
                if envelope.get("isError") is True or "error" in envelope:
                    raise Invalid("tool error is not verified ground truth")
                if envelope.get("complete") is False or envelope.get("omitted") or explicitly_incomplete(envelope):
                    raise Invalid("explicitly incomplete ground-truth response")
            loaded[eid] = value
            loaded_payloads[eid] = body
        except (Invalid, OSError, TypeError, ValueError):
            check(False, "evidence_artifact_invalid", "evidence." + str(eid))

    cases = corpus.get("cases", [])
    if not isinstance(cases, list):
        cases = []
    check(len(cases) == 40, "exactly_40_cases_required", "cases")
    ids, splits, languages, group_counts = Counter(), Counter(), Counter(), Counter()
    episodes = defaultdict(list)
    seen_boundaries = defaultdict(set)
    seen_queries = defaultdict(set)
    abstentions = tasks = 0
    for index, case in enumerate(cases):
        loc = "cases[" + str(index) + "]"
        if not isinstance(case, dict):
            check(False, "case_object", loc)
            continue
        cid = case.get("id")
        check(nonempty(cid), "case_id", loc)
        if isinstance(cid, str):
            ids[cid] += 1
        split, language, group = case.get("split"), case.get("language"), case.get("group")
        check(split in {"development", "heldout"}, "split", loc)
        check(language in {"ro", "en"}, "language", loc)
        check(group in GROUPS, "primary_group", loc)
        for counter, value in ((splits, split), (languages, language), (group_counts, group)):
            if isinstance(value, str):
                counter[value] += 1
        check(nonempty(case.get("question")) and nonempty(case.get("intendedTask")), "natural_question", loc)
        check(string_list(case.get("tags")), "secondary_tags", loc)
        check(nonempty(case.get("episodeId")) and nonempty(case.get("intentId")), "episode_identity", loc)
        if nonempty(case.get("intentId")):
            seen_boundaries["intent:" + case["intentId"]].add(str(split))
        if isinstance(case.get("episodeId"), str):
            episodes[case["episodeId"]].append(case)
        check(string_list(case.get("episodeKeys")) and bool(case.get("episodeKeys")), "semantic_keys", loc)
        origin = case.get("origin")
        check(origin in {"natural", "audit_regression", "synthetic"}, "origin", loc)
        if kind == "private_natural":
            check(origin != "synthetic", "synthetic_not_private", loc)
        if split == "heldout":
            check(case.get("exposure") == "unseen" and origin != "audit_regression", "heldout_exposure", loc)
        for token in case.get("episodeKeys", []) if isinstance(case.get("episodeKeys"), list) else []:
            if isinstance(token, str):
                seen_boundaries["semantic:" + token].add(str(split))
        if isinstance(case.get("question"), str):
            seen_queries[normalized(case["question"])].add(str(split))
        temporal = case.get("temporal", {})
        case_capture = None
        try:
            utc(temporal["validAt"])
            case_capture = capture_time(temporal["capturedAt"], loc + ".temporal.capturedAt")
            if manifest_capture is not None:
                check(manifest_capture >= case_capture, "manifest_capture_before_case", loc)
            for key in ("eventAt", "effectiveFrom", "effectiveTo"):
                if key not in temporal:
                    raise Invalid("explicit temporal unknown required")
                if temporal[key] is not None:
                    utc(temporal[key])
            check(type(temporal["includeHistorical"]) is bool and isinstance(temporal["unknowns"], list),
                  "temporal_scope", loc)
        except (Invalid, KeyError, TypeError):
            check(False, "temporal_contract", loc)
        contract = case.get("toolContract", {})
        check(isinstance(contract, dict) and contract.get("tool") in READ_TOOLS
              and isinstance(contract.get("arguments"), dict), "read_only_tool_contract", loc)
        expected = case.get("expected", {})
        if not isinstance(expected, dict):
            expected = {}
        answerability = expected.get("answerability")
        check(answerability in {"answerable", "abstain"}, "answerability", loc)
        if answerability == "abstain":
            abstentions += 1
            check(nonempty(expected.get("abstentionReason")), "abstention_reason", loc)
        else:
            check(expected.get("abstentionReason") is None, "unexpected_abstention_reason", loc)
        target_ids = set()
        for key in ("recordIds", "sourceIds", "taskIds", "currentRecordIds", "forbiddenRecordIds"):
            values = expected.get(key)
            check(string_list(values), "identity_list", loc + "." + key)
            if isinstance(values, list):
                for value in values:
                    if isinstance(value, str):
                        target_ids.add(value)
                        seen_boundaries["identity:" + value].add(str(split))
        check("nextAction" in expected and string_list(expected.get("forbiddenActions")), "action_contract", loc)
        if answerability == "answerable":
            check(bool(expected.get("recordIds") or expected.get("sourceIds") or expected.get("taskIds")),
                  "answerable_identity_required", loc)
        claims = expected.get("claims", [])
        check(isinstance(claims, list) and bool(claims), "evidence_supported_claim_or_unknown_required", loc)
        ground = case.get("groundTruth", {})
        if not isinstance(ground, dict):
            ground = {}
        refs = ground.get("evidenceIds", [])
        check(ground.get("status") == "verified" and nonempty(ground.get("verifier"))
              and nonempty(ground.get("rationale")) and string_list(refs) and bool(refs),
              "ground_truth_verification", loc)
        try:
            utc(ground.get("verifiedAt"))
        except Invalid:
            check(False, "utc_timestamp", loc + ".groundTruth.verifiedAt")
        valid_refs = set(refs) if string_list(refs) else set()
        check(valid_refs <= loaded.keys(), "ground_truth_evidence_missing", loc)
        observed_ids = set().union(*(scalars(loaded_payloads[eid]) for eid in valid_refs if eid in loaded_payloads))
        check(target_ids <= observed_ids, "expected_identity_not_in_evidence", loc)
        for eid in valid_refs:
            if eid not in loaded:
                continue
            seen_boundaries["evidence-id:" + eid].add(str(split))
            seen_boundaries["evidence-hash:" + evidence[eid]["sha256"]].add(str(split))
            for key in ("recordId", "taskId", "sourceId"):
                identity_value = loaded[eid]["arguments"].get(key)
                if nonempty(identity_value):
                    seen_boundaries["capture-target:" + identity_value].add(str(split))
            try:
                if case_capture is not None:
                    check(case_capture >= utc(loaded[eid]["capturedAt"]), "case_capture_before_evidence", loc)
                check(utc(ground.get("verifiedAt")) >= utc(loaded[eid]["capturedAt"]),
                      "verification_before_capture", loc)
            except Invalid:
                check(False, "utc_timestamp", loc + ".groundTruth.verifiedAt")
        for claim in claims if isinstance(claims, list) else []:
            check(isinstance(claim, dict) and nonempty(claim.get("text"))
                  and string_list(claim.get("evidenceIds")) and bool(claim.get("evidenceIds"))
                  and set(claim["evidenceIds"]) <= valid_refs,
                  "claim_evidence", loc)
        eligibility = case.get("eligibility", {})
        check(isinstance(eligibility, dict) and set(eligibility) == set(SCORED)
              and all(type(x) is bool for x in eligibility.values()), "metric_eligibility", loc)
        if not isinstance(eligibility, dict):
            eligibility = {}
        for stem, key, path_key in (("record", "recordIds", "recordListPointer"),
                                    ("source", "sourceIds", "sourceListPointer")):
            if any(eligibility.get(stem + "RecallAt" + str(k)) for k in (5, 10)):
                check(answerability == "answerable" and bool(expected.get(key)), "recall_denominator", loc)
                check(nonempty(contract.get(path_key)) and contract[path_key].startswith("/"),
                      "explicit_ranked_list_required", loc)
        task = expected.get("taskStateOracle")
        if task is not None:
            tasks += 1
            check(isinstance(task, dict) and set(task) == TASK_FIELDS
                  and eligibility.get("taskState") is True and bool(expected.get("taskIds")),
                  "complete_task_oracle", loc)
        else:
            check(eligibility.get("taskState") is False, "task_eligibility", loc)
        for metric, oracle in (("taskState", task), ("provenance", expected.get("provenanceOracle")),
                               ("presentation", expected.get("presentationOracle"))):
            if eligibility.get(metric):
                check(isinstance(oracle, dict) and bool(oracle), "oracle_required", loc + "." + metric)
                for assertion in oracle.values() if isinstance(oracle, dict) else []:
                    check(isinstance(assertion, dict) and nonempty(assertion.get("pointer"))
                          and assertion["pointer"].startswith("/") and "value" in assertion,
                          "explicit_oracle_value", loc + "." + metric)
        if eligibility.get("identityCurrentness"):
            check(bool(expected.get("currentRecordIds") or expected.get("forbiddenRecordIds")),
                  "temporal_identity_oracle", loc)

    check(all(n == 1 for n in ids.values()), "duplicate_case_id", "cases")
    check(splits == Counter(development=20, heldout=20), "split_20_20", "cases")
    check(languages == Counter(ro=20, en=20), "language_20_20", "cases")
    check(group_counts == Counter({group: 4 for group in GROUPS}), "four_per_group", "cases")
    check(abstentions >= 6, "six_abstentions_required", "cases")
    check(tasks >= 8, "eight_task_cases_required", "cases")
    check(len(episodes) == 20, "twenty_independent_episodes_required", "cases")
    for episode, pair in episodes.items():
        check(len(pair) == 2 and {x.get("language") for x in pair} == {"ro", "en"}
              and len({x.get("split") for x in pair}) == 1
              and len({x.get("group") for x in pair}) == 1
              and len({x.get("intentId") for x in pair}) == 1,
              "episode_pair", "episodes." + episode)
        if len(pair) == 2:
            projections = [{k: c.get(k) for k in ("expected", "temporal", "eligibility", "episodeKeys")}
                           for c in pair]
            # Claims may be translated; their evidence and all operational oracles must agree.
            for projection in projections:
                projection["expected"] = dict(projection["expected"] or {})
                projection["expected"]["claims"] = [x.get("evidenceIds") for x in
                                                     projection["expected"].get("claims", [])]
            check(projections[0] == projections[1], "translation_oracle_drift", "episodes." + episode)
    for group in GROUPS:
        for split in ("development", "heldout"):
            subset = [x for x in cases if isinstance(x, dict) and x.get("group") == group and x.get("split") == split]
            check(len(subset) == 2 and {x.get("language") for x in subset} == {"ro", "en"},
                  "stratified_episode_split", "groups." + group + "." + split)
    check(all(len(x) == 1 for x in seen_boundaries.values()), "cross_split_episode_or_identity_overlap", "cases")
    check(all(len(x) == 1 for x in seen_queries.values()), "cross_split_normalized_duplicate", "cases")
    return {"status": "READY" if not errors else "BLOCKED", "scope": "corpus_structure_and_evidence",
            "kind": kind, "errors": errors,
            "evidenceCapturedThrough": max((v["capturedAt"] for v in loaded.values()), key=utc, default=None),
            "coverage": {"cases": len(cases), "splits": dict(splits), "languages": dict(languages),
                         "groups": dict(group_counts), "episodes": len(episodes),
                         "abstentionCases": abstentions, "taskCases": tasks},
            "limitations": ["Verifier and semantic-independence attestations need human/agent evidence review.",
                            "This does not complete the broader usage/population baseline or establish agent usefulness."]}


def validate(corpus, evidence_root):
    try:
        return _validate(corpus, evidence_root)
    except (AttributeError, TypeError, KeyError, ValueError, RecursionError):
        return {"status": "BLOCKED", "scope": "corpus_structure_and_evidence",
                "errors": [{"code": "malformed_nested_shape", "location": "corpus"}]}


def freeze(corpus, evidence_root, frozen_at):
    result = validate(corpus, evidence_root)
    if result["status"] != "READY":
        raise Invalid("private freeze blocked; inspect validate output")
    utc(frozen_at)
    captured_times = [result["evidenceCapturedThrough"], corpus["manifest"]["capturedAt"]]
    captured_times += [case["temporal"]["capturedAt"] for case in corpus["cases"]]
    if any(utc(captured) > utc(frozen_at) for captured in captured_times):
        raise Invalid("capture occurred after freeze")
    for case in corpus["cases"]:
        if utc(case["groundTruth"]["verifiedAt"]) > utc(frozen_at):
            raise Invalid("ground truth verified after freeze")
    if utc(corpus["splitReview"]["verifiedAt"]) > utc(frozen_at):
        raise Invalid("split review occurred after freeze")
    if corpus.get("kind") != "private_natural":
        raise Invalid("synthetic fixtures cannot be frozen as natural")
    return {"schemaVersion": 1, "status": "FROZEN", "frozenAt": frozen_at,
            "corpusSha256": digest(corpus),
            "splitSha256": digest([{k: c[k] for k in ("id", "episodeId", "episodeKeys", "split")}
                                   for c in corpus["cases"]]),
            "caseSha256": {c["id"]: case_hash(c) for c in corpus["cases"]},
            "corpus": corpus}


def payload(full_result):
    if not isinstance(full_result, dict):
        raise Invalid("MCP object required")
    structured = full_result.get("structuredContent")
    if "structuredContent" in full_result and not isinstance(structured, dict):
        raise Invalid("Structured MCP payload must be an object")
    content = full_result.get("content", [])
    if not isinstance(content, list):
        raise Invalid("MCP content must be an array")
    texts = []
    for item in content:
        if not isinstance(item, dict):
            raise Invalid("MCP content block must be an object")
        if item.get("type") == "text":
            if not isinstance(item.get("text"), str):
                raise Invalid("MCP text block must contain a string")
            texts.append(item["text"])
    if texts:
        if len(texts) != 1:
            raise Invalid("No unique textual MCP payload")
        decoded = loads(texts[0])
        if not isinstance(decoded, dict):
            raise Invalid("Textual MCP payload must be a JSON object")
        if structured is not None and canonical(structured) != canonical(decoded):
            raise Invalid("Structured and textual MCP payloads disagree")
        return decoded
    if structured is not None:
        return structured
    raise Invalid("No unique structured MCP payload; no fabricated empty result")


def measure_mcp(full_result):
    """Size diagnostics only. No recall, answer, task-success or billing inference."""
    if not isinstance(full_result, dict):
        raise Invalid("MCP object required")
    try:
        body = payload(full_result)
    except Invalid:
        body = None
    logical = canonical(body) if body is not None else None
    return {
        "status": "MEASURED",
        "scope": "serialization diagnostics only",
        "logicalPayloadStatus": "available" if body is not None else "unavailable",
        "charUnit": "unicode_code_points",
        "logicalStructuredChars": len(logical) if logical is not None else None,
        "logicalStructuredUtf16Units": len(logical.encode("utf-16-le")) // 2 if logical is not None else None,
        "logicalStructuredUtf8Bytes": len(logical.encode("utf-8")) if logical is not None else None,
        "completeSerializedMcpResultUtf8Bytes": len(canonical(full_result).encode("utf-8")),
        "toolReportedError": full_result.get("isError") is True,
        "omissions": {key: body.get(key) for key in ("truncated", "omitted", "completeness")
                      if body is not None and key in body},
        "retrievalQuality": "NOT_RUN",
        "agentUsefulness": "NOT_RUN",
        "abstentionCorrectness": "NOT_RUN",
        "providerTokens": None,
        "providerCost": None,
        "limitations": [
            "The complete result is serialized once, including both MCP content and structuredContent.",
            "This is JSON serialization size, not HTTP wire size or billed tokens.",
            "Transport success, omissions, tool errors and agent task success remain distinct.",
            "Use the existing ContextKeep evaluators for retrieval; their fixtures and floors are unchanged.",
        ],
    }


def write_exclusive(path, value):
    path = Path(path)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n")
        handle.flush()
        os.fsync(handle.fileno())


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("validate", "freeze", "measure"))
    parser.add_argument("input", type=Path)
    parser.add_argument("--evidence-root", type=Path)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args(argv)
    try:
        if args.action == "freeze" and args.out is None:
            raise Invalid("--out required for private freeze; corpus content is never printed")
        value = read_json(args.input)
        if args.action == "measure":
            result = measure_mcp(value)
        else:
            if args.evidence_root is None:
                raise Invalid("--evidence-root required")
            if args.action == "validate":
                result = validate(value, args.evidence_root)
            else:
                result = freeze(value, args.evidence_root, datetime.now(timezone.utc).isoformat())
        if args.out:
            write_exclusive(args.out, result)
            if args.action == "freeze":
                print(json.dumps({"status": result["status"], "corpusSha256": result["corpusSha256"],
                                  "splitSha256": result["splitSha256"],
                                  "caseCount": len(result["corpus"]["cases"]),
                                  "fileSha256": hashlib.sha256(args.out.read_bytes()).hexdigest()}))
        else:
            print(json.dumps(result, ensure_ascii=False, allow_nan=False))
        return 0 if result["status"] in {"READY", "FROZEN", "MEASURED"} else 2
    except (Invalid, OSError, KeyError, TypeError, ValueError, RecursionError) as exc:
        print(json.dumps({"status": "BLOCKED", "errorType": type(exc).__name__, "reason": str(exc)}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
