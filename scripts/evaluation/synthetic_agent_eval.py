"""Render and score a fixed-evidence, wholly synthetic agent cohort offline."""

import argparse
import json
from pathlib import Path


FIXTURE = Path(__file__).with_name("synthetic_agent_cases.json")


def load_cases():
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    cases = []
    oracle = {}
    for episode in fixture["episodes"]:
        for language, question in episode["questions"].items():
            case_id = f"{episode['id']}-{language}"
            if case_id in oracle:
                raise ValueError(f"Duplicate formulation: {case_id}")
            cases.append({"id": case_id, "question": question, "evidence": episode["evidence"]})
            oracle[case_id] = episode["expected"]
    return fixture["prompt"], cases, oracle, len(fixture["episodes"])


def normalized(answer):
    return answer.strip().casefold()


def score(oracle, episodes, response):
    rows = response["cases"]
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


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["prompt", "score"])
    parser.add_argument("answer", nargs="?", type=Path, help="Structured JSON answer to score")
    args = parser.parse_args()
    prompt, cases, oracle, episode_count = load_cases()
    if args.command == "prompt" and args.answer is None:
        print(prompt + "\n\n" + json.dumps(cases, ensure_ascii=False, indent=2))
    elif args.command == "score" and args.answer is not None:
        answer = json.loads(args.answer.read_text(encoding="utf-8"))
        print(json.dumps(score(oracle, episode_count, answer), indent=2))
    else:
        parser.error("Only the score command takes an answer file")


if __name__ == "__main__":
    main()
