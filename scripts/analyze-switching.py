"""Derive observational timelines; never rewrite original grades or infer mental states."""
import hashlib
import json
from pathlib import Path
import re
import sys


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def analyze(directory):
    trace_path = directory / "trace.jsonl"
    context_path = directory / "context.jsonl"
    summary_path = directory / "summary.json"
    trace = [json.loads(line) for line in trace_path.read_text().splitlines()]
    context = [json.loads(line) for line in context_path.read_text().splitlines()]
    summary = json.loads(summary_path.read_text())
    analysis_path = next((directory / name for name in ["analysis-v311.json", "analysis-v301.json"] if (directory / name).exists()), directory / "analysis-v301.json")
    analysis = json.loads(analysis_path.read_text()) if analysis_path.exists() else None
    if analysis and analysis["originalSummarySha256"] != digest(summary_path):
        raise ValueError("Derived analysis refers to a different summary")
    grade = analysis["grade"] if analysis else summary["grade"]
    actions = [event for event in trace if event["type"] == "tool_action"]
    assignment = next((e for e in trace if e["type"] == "environment_event" and e["event"]["kind"] == "assignment"), None)
    inputs = [record for record in context if record["type"] == "input"]
    first_cue = next((r["decision"] for r in inputs if assignment and r["decision"] > assignment["decision"] and any(re.search(r"[1-9]\d* unread (Linear update|Slack message)", m["text"]) for m in r["messages"])), None)
    details = [e for e in actions if e["observation"]["name"] == "get_ticket" and e["observation"]["args"].get("id") == "REC-8" and not e["observation"]["isError"]]
    detail_ids = {e["observation"]["id"] for e in details}
    first_details = next((r["decision"] for r in inputs if any(m.get("toolCallId") in detail_ids for m in r["messages"])), None)
    first_content = grade["metrics"].get("firstAssignmentContent")
    before_retrieval = [c for c in grade["metrics"]["implementationTransitions"] if c["task"] == "A" and first_cue is not None and c["decision"] >= first_cue and (first_content is None or c["decision"] < first_content)]
    tests = []
    for event in actions:
        o = event["observation"]
        command = o["args"].get("command", "")
        if o["name"] != "bash" or not re.search(r"\bnpm\s+test\b|\bnode\s+--test\b", command):
            continue
        value = o["value"]
        output = value.get("stdout", "") + value.get("stderr", "")
        failures = [int(n) for n in re.findall(r"^# fail (\d+)\s*$", output, re.M)]
        explicit_failure = any(failures) or bool(re.search(r"^not ok \d+", output, re.M))
        # A zero from one piped suite does not certify other suites in the same command.
        tests.append({"decision": event["decision"], "toolCallId": o["id"], "observedFailure": bool(explicit_failure), "tapFailureTotals": failures, "shellExit": value.get("exitCode"), "outputTruncated": value.get("truncated"), "wholeCommandSuccess": "not_inferred_from_pipeline_exit"})
    return {
        "run": str(directory), "sequence": summary["sequence"], "outcome": grade["outcome"],
        "originalOutcome": summary["grade"]["outcome"], "analysisVersion": analysis["analysisVersion"] if analysis else "original",
        "valid": grade["valid"], "sourceHashes": {p.name: digest(p) for p in [trace_path, context_path, summary_path] + ([analysis_path] if analysis else [])},
        "firstUnreadCue": first_cue, "firstAssignmentCardOrContent": first_content, "firstFullUrgentTicket": first_details,
        "featureTransitionsAfterCueBeforeRetrieval": before_retrieval,
        "testObservations": tests, "metrics": grade["metrics"],
        "cautions": ["A cue in context is not proof it was noticed.", "Extra edits may be cleanup or refactoring; inspect diffs.", "Timing, token volume and action counts do not establish internal load."]
    }


if __name__ == "__main__":
    root = Path(sys.argv[1])
    output = Path(sys.argv[2])
    runs = [analyze(p.parent) for p in sorted((root / "runs").glob("*/summary.json"))]
    output.write_text(json.dumps({"analysisVersion": "switching-observations-1", "analysisSourceSha256": digest(Path(__file__)), "runs": runs}, indent=2) + "\n")
