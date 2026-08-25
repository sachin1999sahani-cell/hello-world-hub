import sys, time
sys.path.insert(0, "/root/rbnt-analytics/backend")
import db
db.init_db()

from jobs import recipients, claims, vesting

t = time.time()
n, detail, _ = recipients.sync_all()
print(f"[{time.time()-t:.0f}s] recipients: {n} managers -> {detail[:400]}", flush=True)

t = time.time()
n, detail, dt = claims.refresh_stats_chunk(limit=40)
print(f"[{time.time()-t:.0f}s] claims: {detail[:400]}", flush=True)

t = time.time()
n, detail, dt = vesting.run()
print(f"[{time.time()-t:.0f}s] vesting: {detail[:400]}", flush=True)

print("SEED_DONE", flush=True)
