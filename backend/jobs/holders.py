import time

import db
from sources import routescan
from config import WRBNT


KNOWN_LABELS = {}  # populated lazily: wallet -> (venue, confidence, cex)


def _known_map():
    m = {}
    for r in db.q("SELECT address FROM managers"):
        m[r["address"]] = ("protocol", "identified", None)
    for r in db.q("SELECT DISTINCT address FROM pools"):
        m[r["address"]] = ("dex-pool", "identified", None)
    for r in db.q("SELECT * FROM treasury"):
        m[r["address"]] = ("treasury", r["confidence"], None)
    for r in db.q("SELECT * FROM cex_anchors"):
        m[r["address"]] = ("cex", "identified", r["exchange"])
    for r in db.q("SELECT * FROM cex_clusters"):
        m.setdefault(r["address"], ("cex", "clustered", r["exchange"]))
    return m


def run(pages=10):
    t0 = time.time()
    snap = int(time.time())
    known = _known_map()
    rank = 0
    rows = []
    for page in range(1, pages + 1):
        try:
            holders = routescan.tokenholderlist(WRBNT, page=page, offset=100)
        except RuntimeError:
            break
        if not holders:
            break
        for h in holders:
            rank += 1
            w = h["TokenHolderAddress"].lower()
            venue, conf, cex = known.get(w, ("unknown", "unconfirmed", None))
            rows.append((rank, w, str(int(h["TokenHolderQuantity"])), venue, conf, cex, snap))
    db.exmany("""INSERT OR REPLACE INTO top_holders(rank,wallet,balance_raw,venue,confidence,cex_guess,snapshot_at)
                 VALUES(?,?,?,?,?,?,?)""", rows)
    # keep last 5 snapshots
    snaps = [r["snapshot_at"] for r in db.q("SELECT DISTINCT snapshot_at FROM top_holders ORDER BY snapshot_at DESC")]
    for old in snaps[5:]:
        db.ex("DELETE FROM top_holders WHERE snapshot_at=?", (old,))
    return len(rows), f"holders={len(rows)}", time.time() - t0
