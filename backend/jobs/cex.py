import json
import time

import db

LOOKBACK_DAYS = 60


def cluster_from_anchors(min_count=3, min_volume=1e24):
    """Best-effort CEX hot-wallet clustering.

    Method: for each confirmed anchor (manual test-deposit addresses), scan the
    rolling raw-transfer window for inbound WRBNT flows. Addresses that send to
    an anchor repeatedly, or move >1M WRBNT into one, score as likely hot
    wallets. Everything stays labeled clustered - never identified.
    """
    t0 = time.time()
    anchors = db.q("SELECT * FROM cex_anchors")
    cutoff = int(time.time()) - LOOKBACK_DAYS * 86400
    found = 0
    for anc in anchors:
        a = anc["address"].lower()
        rows = db.q("SELECT frm, value_raw FROM transfers_raw WHERE to_addr=? AND ts>?", (a, cutoff))
        agg = {}
        for r in rows:
            e = agg.setdefault(r["frm"], [0, 0])
            e[0] += 1
            e[1] += int(r["value_raw"])
        for s, (cnt, vol) in agg.items():
            if cnt >= min_count or vol > min_volume:
                score = min(1.0, (cnt / 10.0) + (vol / 1e27))
                db.ex("""INSERT INTO cex_clusters(exchange,address,anchor,score,inflow_sources,evidence_json,updated_at)
                         VALUES(?,?,?,?,?,?,?)
                         ON CONFLICT(exchange,address) DO UPDATE SET score=excluded.score,
                           inflow_sources=excluded.inflow_sources,
                           evidence_json=excluded.evidence_json, updated_at=excluded.updated_at""",
                      (anc["exchange"], s, a, round(score, 3), cnt,
                       json.dumps({"transfers_to_anchor": cnt, "volume_raw": str(vol)}),
                       int(time.time())))
                found += 1
    return found, f"anchors={len(anchors)} candidates={found}", time.time() - t0
