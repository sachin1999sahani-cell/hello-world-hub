"""Scheduler: registers every job on its spec interval and supports one-shot seeding."""
import logging
import time
import traceback
from datetime import datetime, timedelta, timezone

from apscheduler.schedulers.background import BackgroundScheduler

import db
from config import SCHEDULE
from jobs import managers as j_managers
from jobs import recipients as j_recipients
from jobs import claims as j_claims
from jobs import balances as j_balances
from jobs import vesting as j_vesting
from jobs import treasury as j_treasury
from jobs import dex as j_dex
from jobs import holders as j_holders
from jobs import market as j_market
from jobs import cex as j_cex
from jobs import transfers as j_transfers
from jobs import native as j_native

log = logging.getLogger("poller")

JOBS = {
    "managers": lambda: j_managers.discover_managers(),
    "recipients": lambda: j_recipients.sync_all(),
    "claims": lambda: j_claims.refresh_stats_chunk(),
    "balances": lambda: j_balances.refresh_balances(),
    "vesting": lambda: j_vesting.run(),
    "treasury_seed": lambda: (j_treasury.seed(), ("ok",))[1],
    "treasury": lambda: j_treasury.run(),
    "pools_discover": lambda: j_dex.discover_pools(),
    "pools": lambda: j_dex.refresh_reserves(),
    "sell_impact": lambda: j_dex.scan_swap_events(),
    "holders": lambda: j_holders.run(pages=10),
    "market": lambda: j_market.market(),
    "venue_share": lambda: j_market.venue_volume_share(),
    "bridged": lambda: j_market.bridged(),
    "cex_cluster": lambda: j_cex.cluster_from_anchors(),
    "transfers": lambda: j_transfers.sync(max_chunks=40),
    "native_holders": lambda: j_native.run(),
    "prune": lambda: _prune(),
}


def _prune():
    cutoff = int(time.time()) - 45 * 86400
    db.ex("DELETE FROM transfers_raw WHERE ts < ?", (cutoff,))
    return "ok", f"pruned<{cutoff}"


def run_job(name):
    t0 = time.time()
    try:
        res = JOBS[name]()
        ok = True
        detail = str(res)[:400]
    except Exception as e:
        ok = False
        detail = f"{e} :: {traceback.format_exc()[-300:]}"
        log.error("job %s failed: %s", name, detail)
    db.log_job(name, int(t0), ok, detail + f" [{time.time()-t0:.1f}s]")
    return ok, detail


def build_scheduler():
    sched = BackgroundScheduler(timezone="UTC")
    every = {
        # job -> (interval_key, first_run_delay_secs)
        "managers": ("managers", 10),
        "recipients": ("recipients", 60),
        "claims": ("claims", 90),
        "balances": ("balances", 120),
        "vesting": ("vesting", 150),
        "treasury_seed": (None, 5),
        "treasury": ("treasury", 20),
        "pools_discover": ("pools_discover", 30),
        "pools": ("pools", 45),
        "sell_impact": ("sell_impact", 240),
        "holders": ("holders", 300),
        "market": ("market", 15),
        "venue_share": ("market", 45),
        "bridged": ("bridged", 330),
        "cex_cluster": ("cex_cluster", 420),
        "transfers": ("claims", 30),      # piggyback claims cadence; incremental
        "native_holders": ("holders", 60),
        "prune": ("holders", 3600),
    }
    for name, (key, delay) in every.items():
        secs = SCHEDULE[key] if key else 3600
        sched.add_job(run_job, "interval", seconds=secs, args=[name], id=name,
                      max_instances=1, coalesce=True, misfire_grace_time=secs // 2,
                      next_run_time=datetime.now(timezone.utc) + timedelta(seconds=delay))
    return sched


def initial_pass():
    """Blocking first-run sequence so DB has data before serving."""
    order = ["treasury_seed", "managers", "recipients", "claims", "treasury",
             "market", "vesting", "balances"]
    for name in order:
        log.info("[seed] %s ...", name)
        ok, detail = run_job(name)
        log.info("[seed] %s -> %s %s", name, "ok" if ok else "FAIL", detail)
    # transfers backfill runs incrementally inside the scheduler; kick one pass now
    log.info("[seed] transfers (first slice) ...")
    ok, detail = run_job("transfers")
    log.info("[seed] transfers -> %s %s", "ok" if ok else "FAIL", detail)
    log.info("[seed] pools_discover / holders / bridged ...")
    for name in ("pools_discover", "holders", "bridged"):
        run_job(name)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    db.init_db()
    initial_pass()
