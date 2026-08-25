import time

import db
from sources import routescan
from config import WRBNT


def _scan_manager(manager_addr):
    """Incremental claim scan for one manager: outgoing WRBNT transfers = claims."""
    row = db.one("SELECT last_claims_scan_block FROM managers WHERE address=?", (manager_addr,))
    start_block = int(row["last_claims_scan_block"] or 0)
    latest = routescan.api({"module": "proxy", "action": "eth_blockNumber"})
    latest_block = int(latest, 16)
    if start_block == 0:
        start_block = 1
    new_claims = 0
    lo = start_block
    CHUNK = 400000
    while lo <= latest_block:
        hi = min(lo + CHUNK - 1, latest_block)
        page = 1
        while True:
            try:
                rows = routescan.tokentx_page(manager_addr, WRBNT, page=page, offset=1000,
                                              sort="asc", startblock=lo, endblock=hi)
            except RuntimeError:
                break
            if not rows:
                break
            out_rows = []
            for t in rows:
                if t["from"].lower() == manager_addr.lower():
                    out_rows.append((t["hash"].lower(), manager_addr.lower(), t["to"].lower(),
                                     str(int(t["value"])), int(t["blockNumber"]), int(t["timeStamp"])))
            if out_rows:
                db.exmany("""INSERT OR IGNORE INTO claims(tx_hash,manager,wallet,value_raw,block,ts)
                             VALUES(?,?,?,?,?,?)""", out_rows)
                new_claims += len(out_rows)
            if len(rows) < 1000:
                break
            page += 1
        lo = hi + 1
    db.ex("UPDATE managers SET last_claims_scan_block=? WHERE address=?", (latest_block + 1, manager_addr))
    return new_claims


def refresh_stats_chunk(limit=40):
    """Recompute per-wallet aggregates for wallets with recent claims."""
    t0 = time.time()
    managers = [r["address"] for r in db.q("SELECT address FROM managers ORDER BY last_claims_scan_block")]
    detail = []
    for m in managers[:limit]:
        n = _scan_manager(m)
        detail.append(f"{m[:10]}:+{n}")
    # aggregate into address_stats in python: summed wei exceeds sqlite int64
    rows = db.q("""SELECT wallet, value_raw, ts FROM claims""")
    agg = {}
    for r in rows:
        a = agg.setdefault(r["wallet"], [0, 0, None, None])
        a[0] += int(r["value_raw"])
        a[1] += 1
        a[2] = r["ts"] if a[2] is None else min(a[2], r["ts"])
        a[3] = r["ts"] if a[3] is None else max(a[3], r["ts"])
    db.exmany("""INSERT INTO address_stats(wallet, claimed_total_raw, claims_count, first_claim_ts, last_claim_ts)
                 VALUES(?,?,?,?,?)
                 ON CONFLICT(wallet) DO UPDATE SET
                   claimed_total_raw=excluded.claimed_total_raw,
                   claims_count=excluded.claims_count,
                   first_claim_ts=excluded.first_claim_ts,
                   last_claim_ts=excluded.last_claim_ts""",
              [(w, str(a[0]), a[1], a[2], a[3]) for w, a in agg.items()])
    return len(managers[:limit]), "; ".join(detail), time.time() - t0
