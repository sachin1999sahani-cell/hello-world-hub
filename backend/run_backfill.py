import sys, time, logging
sys.path.insert(0, "/root/rbnt-analytics/backend")
import db
logging.basicConfig(level=logging.INFO)
db.init_db()
from jobs import transfers
from sources.rpc import latest_block

START_RECENT = int(sys.argv[1]) if len(sys.argv) > 1 else 400000  # blocks behind head to begin at

if db.meta_get("wrnt_transfer_scan_block") in (None, "1"):
    head = latest_block()
    db.meta_set("wrnt_transfer_scan_block", max(1, head - START_RECENT))
    print(f"seeded checkpoint to head-{START_RECENT} = {max(1, head - START_RECENT)}", flush=True)

for i in range(1000):
    added, detail, dt = transfers.sync(max_chunks=800)
    print("pass", i, added, detail, f"{dt:.1f}s", flush=True)
    if "caught up" in detail:
        break
print("BACKFILL_DONE", flush=True)
