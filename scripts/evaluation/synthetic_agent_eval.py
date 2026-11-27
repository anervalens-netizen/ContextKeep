"""Render and score a fixed-evidence, wholly synthetic agent cohort offline."""

import argparse
import json
from pathlib import Path


FIXTURE = Path(__file__).with_name("synthetic_agent_cases.json")
MAX_INPUT_BYTES = 2 * 1024 * 1024


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("Duplicate JSON object key")
        result[key] = value
    return result


def _reject_constant(_value):
    raise ValueError("Non-finite JSON value")


def read_json(path):
    """Read bounded JSON only; never execute a fixture or write an input."""
    with Path(path).open("rb") as handle:
        raw = handle.read(MAX_INPUT_BYTES + 1)
    if len(raw) > MAX_INPUT_BYTES:
        raise ValueError("JSON input exceeds 2 MiB")
    return json.loads(raw.decode("utf-8"), object_pairs_hook=_unique_object,
                      parse_constant=_reject_constant)


def _object_fields(value, fields, label):
    if not isinstance(value, dict) or value.keys() != fields:
        raise ValueError(f"{label} has invalid fields")


def _text(value):
    return isinstance(value, str) and bool(value.strip())


def _answer_fields(value, label, include_id=False):
    fields = {"answer", "action", "supportIds"}
    if include_id:
        fields.add("id")
    _object_fields(value, fields, label)
    if not _text(value["answer"]) or not _text(value["action"]):
        raise ValueError(f"{label} needs a nonempty answer and action")
    if include_id and not _text(value["id"]):
        raise ValueError(f"{label} needs a nonempty id")
    ids = value["supportIds"]
    if (not isinstance(ids, list) or not all(_text(item) for item in ids)
            or len(ids) != len(set(ids))):
        raise ValueError(f"{label} needs unique string supportIds")


def load_cases(fixture_path=FIXTURE):
    fixture = read_json(fixture_path)
    _object_fields(fixture, {"prompt", "episodes"}, "Fixture")
    if not _text(fixture["prompt"]):
        raise ValueError("Fixture needs a nonempty prompt")
    episodes = fixture["episodes"]
    if not isinstance(episodes, list) or not episodes:
        raise ValueError("Fixture needs a nonempty episodes array")
    cases = []
    oracle = {}
    episode_ids = set()
    for episode in episodes:
        _object_fields(episode, {"id", "questions", "evidence", "expected"}, "Episode")
        if not _text(episode["id"]) or episode["id"] in episode_ids:
            raise ValueError("Episode needs a unique nonempty id")
        episode_ids.add(episode["id"])
        _object_fields(episode["questions"], {"en", "ro"}, "Questions")
        if not _text(episode["evidence"]) or not all(
                _text(question) for question in episode["questions"].values()):
            raise ValueError("Episode needs nonempty evidence and questions")
        _answer_fields(episode["expected"], "Expected answer")
        for language, question in episode["questions"].items():
            case_id = f"{episode['id']}-{language}"
            if case_id in oracle:
                raise ValueError(f"Duplicate formulation: {case_id}")
            cases.append({"id": case_id, "question": question, "evidence": episode["evidence"]})
            oracle[case_id] = episode["expected"]
    return fixture["prompt"], cases, oracle, len(episodes)


def normalized(answer):
    return answer.strip().casefold()


def score(oracle, episodes, response):
    _object_fields(response, {"cases"}, "Response")
    rows = response["cases"]
    if not isinstance(rows, list):
        raise ValueError("Response needs a cases array")
    for row in rows:
        _answer_fields(row, "Response case", include_id=True)
    by_id = {row["id"]: row for row in rows}
    if len(rows) != len(oracle) or by_id.keys() != oracle.keys():
        raise ValueError("Response needs exactly one row for every case")
    subscores = {"answers": 0, "actions": 0, "sources": 0, "abstentions": 0, "falseAbstentions": 0}
    failures = []
    eligible_abstentions = 0
    for case_id, expected in oracle.items():
        result = by_id[case_id]
        matches = {
            "answers": normalized(result["answer"]) == normalized(expected["answer"]),
            "actions": result["action"] == expected["action"],
            "sources": sorted(result["supportIds"]) == sorted(expected["supportIds"]),
        }
        for metric, correct in matches.items():
            subscores[metric] += int(correct)
            if not correct:
                failures.append({"caseId": case_id, "failedMetric": metric})
        eligible = expected["action"] == "abstain"
        abstained = result["action"] == "abstain" and normalized(result["answer"]) == "unknown"
        eligible_abstentions += int(eligible)
        subscores["abstentions"] += int(eligible and abstained)
        subscores["falseAbstentions"] += int(not eligible and abstained)
    return {
        "formulations": len(oracle),
        "episodes": episodes,
        "eligibleAbstentions": eligible_abstentions,
        "answerableCases": len(oracle) - eligible_abstentions,
        "subscores": subscores,
        "failures": failures,
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["prompt", "score"])
    parser.add_argument("answer", nargs="?", type=Path, help="Structured JSON answer to score")
    parser.add_argument("--fixture", type=Path, default=FIXTURE,
                        help="Read-only bilingual JSON cohort; defaults to the frozen original")
    args = parser.parse_args(argv)
    if (args.command == "prompt") != (args.answer is None):
        parser.error("Only the score command takes an answer file")
    try:
        prompt, cases, oracle, episode_count = load_cases(args.fixture)
        if args.command == "prompt":
            print(prompt + "\n\n" + json.dumps(cases, ensure_ascii=False, indent=2))
        else:
            answer = read_json(args.answer)
            print(json.dumps(score(oracle, episode_count, answer), indent=2))
    except (OSError, UnicodeError, ValueError) as exc:
        parser.error(str(exc))


if __name__ == "__main__":
    main()
