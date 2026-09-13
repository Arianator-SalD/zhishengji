"""Opt-in live evaluation of bundled synthetic cases; never reads real chat logs."""
import argparse
import asyncio
from datetime import datetime, timedelta, timezone
import hashlib
import json
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server.context import Content
from server.providers import OpenAIChat
from server.settings import ROOT, Settings


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--case", action="append", default=[])
    args = parser.parse_args()
    settings = Settings.from_env()
    if not settings.llm_api_key:
        raise SystemExit("Configure LLM_API_KEY before explicitly running live evaluation")
    cases = json.loads((ROOT / "tests/fixtures/robin_generation_cases.json").read_text())
    if args.case:
        cases = [case for case in cases if case["id"] in args.case]
        if len(cases) != len(set(args.case)):
            raise SystemExit("Unknown evaluation case")
    content = Content(ROOT / "content/robin-li", name="李彦宏")
    llm = OpenAIChat(settings)
    metadata = {"model": settings.llm_model, "synthetic": True,
                "started_at": datetime.now(timezone(timedelta(hours=8))).isoformat(),
                "source_sha256": {name: hashlib.sha256((ROOT / name).read_bytes()).hexdigest()
                                  for name in ("server/reply_policy.py", "server/context.py", "server/providers.py", "server/session.py",
                                               "content/robin-li/stable_replies.json")}}
    results = []
    for case in cases:
        for repeat in range(1, 3):
            started = time.monotonic()
            result = {"case": case["id"], "repeat": repeat, "question": case["question"],
                      "expected": case["expected"], "review": case["review"]}
            try:
                prior = case.get("history", [])
                # Do not convert a network error into a successful 'none' decision.
                async with asyncio.timeout(6):
                    decision = await llm.classify_reply(content.reply_policy.classification_messages(case["question"], prior))
                if not isinstance(decision, dict) or set(decision) != {"id"}:
                    raise ValueError("invalid route result")
                route = decision["id"]
                if route not in {"none", *content.reply_policy.by_id}:
                    raise ValueError("unknown route")
                card = content.reply_policy.by_id.get(route)
                history = [*prior, {"role": "user", "content": case["question"]}]
                messages = content.messages(history, True, card)
                async with asyncio.timeout(settings.provider_timeout * 2):
                    stream = llm.stream(messages, temperature=0.2) if card is not None else llm.stream(messages)
                    answer = "".join([delta async for delta in stream])
                result.update(route=route, route_matches=route == case["expected"], answer=answer,
                              nonempty=bool(answer.strip()),
                              concise=len(answer) <= 180,
                              copied_reference=any(answer.strip() == c["answer"].strip() for c in content.reply_policy.cards))
                if case["id"] == "applications-overview":
                    result["anchor_matches"] = "应用驱动" in answer
                if case.get("one_sentence"):
                    result["format_matches"] = len([s for s in re.split(r"[。！？!?\n]+", answer) if s.strip()]) == 1
            except Exception as exc:
                # Fixed type only; no provider bodies, headers, environment or credentials.
                result["error"] = type(exc).__name__
            result["seconds"] = round(time.monotonic() - started, 2)
            results.append(result)
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps({**metadata, "results": results}, ensure_ascii=False, indent=2) + "\n")
            print(f"{case['id']} repeat {repeat}: " + (result.get("error") or f"route={result['route']}, chars={len(result['answer'])}"), flush=True)
    failures = sum(bool(r.get("error")) or not r.get("route_matches", False)
                   or not r.get("nonempty", False) or r.get("copied_reference", False)
                   or not r.get("concise", False) or not r.get("anchor_matches", True)
                   or not r.get("format_matches", True) for r in results)
    print(json.dumps({"runs": len(results), "automatic_failures": failures,
                      "semantic_review": "Review every generated answer against the case rubric"}))
    return int(failures > 0)


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
