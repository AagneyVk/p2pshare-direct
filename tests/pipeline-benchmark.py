"""Paired warm-cache loopback ablation; never a device/network speed claim."""
import json
import os
from pathlib import Path
import statistics
import subprocess

root = Path(__file__).resolve().parents[1]
binary = root / "transport-core/target/release/examples/loopback"
runs = []
for repetition in range(3):
    modes = ("serial", "pipeline") if repetition % 2 == 0 else ("pipeline", "serial")
    for mode in modes:
        output = subprocess.check_output([str(binary), "256"], text=True,
            env={**os.environ, "P2PSHARE_SEND_MODE": mode}, timeout=180)
        result = json.loads(output.strip())
        assert result["integrity_verified"]
        runs.append({"mode": mode, "repetition": repetition, **result})
medians = {mode: statistics.median(r["total_seconds_including_hash_and_sync"]
    for r in runs if r["mode"] == mode) for mode in ("serial", "pipeline")}
report = {"runs": runs, "median_seconds": medians,
          "serial_over_pipeline": medians["serial"] / medians["pipeline"],
          "limitations": "256 MiB, three pairs, shared CI host, warm cache, no phone/energy measurement"}
(root / "pipeline-benchmark.json").write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps(report))
