"""Report counts/IDs only; never echo the private values found in Actions logs."""
import argparse
import json
import re
import subprocess


def gh(*args):
    return subprocess.run(["gh", *args], check=True, capture_output=True, text=True).stdout


parser = argparse.ArgumentParser()
parser.add_argument("--limit", type=int, default=20)
args = parser.parse_args()
runs = json.loads(gh("run", "list", "--workflow", "daily-briefing.yml", "--limit", str(args.limit), "--json", "databaseId,status,createdAt"))
report = []
for run in runs:
    if run["status"] != "completed":
        continue
    try:
        lines = gh("run", "view", str(run["databaseId"]), "--log").splitlines()
    except subprocess.CalledProcessError:
        report.append({"run": run["databaseId"], "logs": "unavailable"})
        continue
    emails = sum(bool(re.search(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}", line)) for line in lines if any(marker in line for marker in ("알림 발송", "메일 발송", "관리자 메일(")))
    targets = sum("보유 종목 추가 수집 대상:" in line or "[1/4] 기업 코드 로드 중... (대상:" in line for line in lines)
    report.append({"run": run["databaseId"], "date": run["createdAt"], "unmasked_recipient_lines": emails, "target_name_lines": targets})
print(json.dumps({"reviewed": len(report), "runs": report}, ensure_ascii=False, indent=2))
