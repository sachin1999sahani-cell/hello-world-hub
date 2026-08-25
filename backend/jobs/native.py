"""Native RBNT balance ranking across every address this app already knows.

There is no ERC-20 style richlist for a native currency, so this ships as
best-effort: candidates come from rosters, claims, treasury, pools, CEX
tables and top WRBNT holder snapshots. UI must label it "ranked among known
addresses", not "complete top holders".
"""
import time

import db
from sources.rpc import w3

CHUNK = 400


def _candidates(limit=3000):
    wallets = set()
    for q in (
        "SELECT wallet AS w FROM recipients",
        "SELECT DISTINCT wallet AS w FROM claims",
        "SELECT address AS w FROM managers",
        "SELECT address AS w FROM treasury",
        "SELECT address AS w FROM pools",
        "SELECT address AS w FROM cex_anchors",
        "SELECT address AS w FROM cex_clusters",
        """SELECT wallet AS w FROM top_holders WHERE snapshot_at =
             (SELECT MAX(snapshot_at) FROM top_holders)""",
        "SELECT frm AS w FROM transfer_edges",
        "SELECT to_addr AS w FROM transfer_edges",
    ):
        try:
            wallets.update(r["w"].lower() for r in db.q(q))
        except Exception:
            continue
    return sorted(wallets)[:limit]


def run():
    t0 = time.time()
    now = int(time.time())
    wallets = _candidates()
    done = db.one("SELECT COUNT(*) c FROM native_holders")["c"]
    # incremental: skip wallets refreshed within the last 6h
    fresh_cutoff = now - 6 * 3600
    todo = [w for w in wallets if not
            (r := db.one("SELECT updated_at FROM native_holders WHERE wallet=?", (w,)))
            or r["updated_at"] < fresh_cutoff]
    batch = todo[:CHUNK]
    n_ok = 0
    rows = []
    for w in batch:
        try:
            bal = str(w3().eth.get_balance(w3().to_checksum_address(w)))
            rows.append((w, bal, now))
            n_ok += 1
        except Exception:
            continue
    if rows:
        db.exmany("""INSERT INTO native_holders(wallet,balance_raw,updated_at) VALUES(?,?,?)
                     ON CONFLICT(wallet) DO UPDATE SET balance_raw=excluded.balance_raw,
                       updated_at=excluded.updated_at""", rows)
    return n_ok, f"known={len(wallets)} polled={len(batch)} of {len(todo)} pending (done={done})", time.time() - t0
