import json
import time

from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from sources import db
from config import SCHEDULE, BRIDGED_WRBNT

app = FastAPI(title="RBNT Analytics", docs_url="/api/docs")

# when the frontend is hosted separately (e.g. Vercel static) it calls this API
# cross-origin; the browser sends no credentials so a permissive origin list is safe
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def _startup():
    db.init_db()


def _fmt_ts(ts):
    return int(ts) if ts else None


# ---------- Page 1: node operators ----------

PRIMARY_MANAGER = "0x7199d184ee85d738bb347e0b1d53544007c5d7fc"


@app.get("/api/node-operators")
def node_operators(scope: str = "primary"):
    """scope=primary pins the fully cross-validated manager 0x7199...D7FC.
    scope=all returns the 23-manager aggregate (reconciliation caveat applies)."""
    if scope == "all":
        managers = db.q("SELECT * FROM managers WHERE kind='signup'")
        claim_rows = db.q("""
            SELECT c.wallet, c.value_raw FROM claims c
            JOIN managers m ON c.manager=m.address WHERE m.kind='signup'
        """)
        roster = db.one("""
            SELECT COUNT(*) AS roster FROM recipients r
            JOIN managers m ON r.manager=m.address WHERE m.kind='signup'
        """)
        scope_note = "All signup managers pooled. Cross-manager reconciliation is an open item."
        never_claimed = []
        for m in managers:
            rows = db.q("""SELECT wallet FROM recipients WHERE manager=? AND wallet NOT IN
                           (SELECT DISTINCT wallet FROM claims WHERE manager=?)""",
                        (m["address"], m["address"]))
            never_claimed.append({"manager": m["address"], "count": len(rows)})
        updated_at = max([_fmt_ts(m["last_roster_sync"]) or 0 for m in managers] or [0])
    else:
        mgr = PRIMARY_MANAGER
        mrow = db.one("SELECT * FROM managers WHERE address=?", (mgr,))
        managers = [mrow] if mrow else []
        claim_rows = db.q("SELECT wallet, value_raw, ts FROM claims WHERE manager=?", (mgr,))
        roster = {"roster": db.one("SELECT COUNT(*) c FROM recipients WHERE manager=?", (mgr,))["c"]}
        scope_note = f"Single verified manager {mgr}."
        never_claimed = [{"manager": mgr,
                          "wallets": [r["wallet"] for r in db.q(
                              """SELECT wallet FROM recipients WHERE manager=? AND wallet NOT IN
                                 (SELECT DISTINCT wallet FROM claims WHERE manager=?) ORDER BY wallet""",
                              (mgr, mgr))]}]
        updated_at = _fmt_ts(mrow["last_roster_sync"]) if mrow else None
    totals = {
        "unique_claimers": len({r["wallet"] for r in claim_rows}),
        "total_claimed_raw": str(sum(int(r["value_raw"]) for r in claim_rows)),
        "claim_txs": len(claim_rows),
    }
    wallets = {r["wallet"] for r in claim_rows}
    placeholders = ",".join("?" for _ in wallets) or "''"
    leaderboard = db.q(f"""
        SELECT wallet, claimed_total_raw, claims_count, first_claim_ts, last_claim_ts,
               balance_raw, sell_signal_score, last_sell_signal_ts
        FROM address_stats
        WHERE wallet IN ({placeholders})
        ORDER BY length(COALESCE(balance_raw,'0')) DESC, COALESCE(balance_raw,'0') DESC
    """, tuple(wallets))
    return {
        "scope": scope,
        "primary_manager": PRIMARY_MANAGER if scope == "primary" else None,
        "scope_note": scope_note,
        "managers": [dict(m) for m in managers],
        "roster_size": roster["roster"] if roster else 0,
        "unique_claimers": totals["unique_claimers"],
        "total_claimed_raw": totals["total_claimed_raw"],
        "claim_txs": totals["claim_txs"],
        "leaderboard": [dict(r) for r in leaderboard],
        "never_claimed_by_manager": never_claimed,
        "updated_at": updated_at,
    }


@app.get("/api/retention")
def retention():
    managers = db.q("SELECT * FROM managers WHERE kind='retention'")
    out = []
    for m in managers:
        windows = {}
        for v in db.q("SELECT * FROM vestings WHERE manager=?", (m["address"],)):
            lbl = v["window_label"] or "part1"
            w = windows.setdefault(lbl, {"part": lbl, "claimed": 0, "holding": 0,
                                         "not_claimed": 0, "total": 0})
            w["total"] += 1
            if v["state"]:
                w[v["state"]] += 1
        out.append({"manager": m["address"],
                    "recipients_cached": m["recipients_cached"],
                    "windows": sorted(windows.values(), key=lambda x: x["part"])})
    return {"managers": out}


@app.get("/api/retention/recipients")
def retention_recipients(manager: str, page: int = 1, per_page: int = 50):
    """Per-recipient window states for one manager, paginated."""
    per_page = max(10, min(per_page, 100))
    rows = db.q("""SELECT wallet, vesting_id, window_label, state,
                   released_or_claimed_raw, linear_amount_raw, cliff_amount_raw,
                   initial_unlock_raw, start_ts, end_ts
                   FROM vestings WHERE manager=? ORDER BY wallet, start_ts""", (manager.lower(),))
    by_wallet = {}
    for r in rows:
        alloc = int(r["linear_amount_raw"] or 0) + int(r["cliff_amount_raw"] or 0) + int(r["initial_unlock_raw"] or 0)
        by_wallet.setdefault(r["wallet"], []).append({
            "part": r["window_label"], "state": r["state"],
            "claimed_raw": r["released_or_claimed_raw"],
            "alloc_raw": str(alloc),
            "start_ts": r["start_ts"], "end_ts": r["end_ts"],
        })
    wallets = sorted(by_wallet.keys())
    total = len(wallets)
    page = max(1, page)
    lo = (page - 1) * per_page
    items = [{"wallet": w, "windows": by_wallet[w]} for w in wallets[lo:lo + per_page]]
    return {"manager": manager, "page": page, "per_page": per_page,
            "total": total, "pages": (total + per_page - 1) // per_page, "items": items}


# ---------- Page 2: treasury ----------

@app.get("/api/treasury")
def treasury():
    rows = db.q("SELECT * FROM treasury ORDER BY updated_at DESC")
    return {"wallets": [dict(r) for r in rows]}


# ---------- Page 3: dex ----------

@app.get("/api/dex")
def dex():
    pools = db.q("SELECT * FROM pools")
    sells = db.q("""SELECT * FROM large_sells ORDER BY ts DESC LIMIT 150""")
    latest_snap = db.one("SELECT MAX(snapshot_at) AS s FROM top_holders")
    holders = []
    if latest_snap and latest_snap["s"]:
        holders = [dict(r) for r in db.q(
            "SELECT * FROM top_holders WHERE snapshot_at=? AND venue!='cex' ORDER BY rank LIMIT 100",
            (latest_snap["s"],))]
    native = db.q("SELECT * FROM native_holders ORDER BY length(balance_raw) DESC, balance_raw DESC LIMIT 100")
    swaps_by_pool = db.q("""SELECT pool, COUNT(*) n FROM large_sells WHERE kind='swap'
                            GROUP BY pool ORDER BY n DESC""")
    return {"pools": [dict(p) for p in pools],
            "large_sells": [dict(s) for s in sells],
            "top_holders": holders,
            "native_holders": [dict(r) for r in native],
            "swaps_by_pool": [dict(r) for r in swaps_by_pool],
            "native_note": "ranked among known addresses - no complete native richlist source exists yet"}


@app.get("/api/wallet/{address}")
def wallet_profile(address: str):
    import re
    from sources.rpc import w3
    from web3 import Web3
    if not re.fullmatch(r"0x[0-9a-fA-F]{40}", address):
        raise HTTPException(400, "address must be a 42-char hex string")
    a = Web3.to_checksum_address(address)
    lower = address.lower()
    now = int(time.time())
    try:
        native_raw = str(w3().eth.get_balance(a))
        wrbnt_c = w3().eth.contract(
            address=Web3.to_checksum_address("0x6ed1F491e2d31536D6561f6bdB2AdC8F092a6076"),
            abi=[{"name": "balanceOf", "type": "function", "stateMutability": "view",
                  "inputs": [{"name": "", "type": "address"}],
                  "outputs": [{"name": "", "type": "uint256"}]}])
        wrbnt_raw = str(wrbnt_c.functions.balanceOf(a).call())
    except Exception as e:
        raise HTTPException(502, f"rpc error: {e}")

    managers = [dict(r) for r in db.q(
        """SELECT m.* FROM recipients r JOIN managers m ON r.manager=m.address WHERE r.wallet=?""",
        (lower,))]
    stats = db.one("SELECT * FROM address_stats WHERE wallet=?", (lower,))
    vestings = [dict(r) for r in db.q(
        """SELECT v.*, m.kind FROM vestings v JOIN managers m ON v.manager=m.address
           WHERE v.wallet=? ORDER BY v.start_ts""", (lower,))]
    treasury_row = db.one("SELECT label, note, confidence FROM treasury WHERE address=?", (lower,))
    holder_row = db.one("""SELECT venue, confidence, cex_guess FROM top_holders WHERE wallet=?
                           ORDER BY snapshot_at DESC LIMIT 1""", (lower,))
    anchor = db.one("SELECT exchange FROM cex_anchors WHERE address=?", (lower,))
    cluster = db.one("SELECT exchange, score FROM cex_clusters WHERE address=?", (lower,))
    recent_claims = [dict(r) for r in db.q(
        "SELECT tx_hash, manager, value_raw, block, ts FROM claims WHERE wallet=? ORDER BY ts DESC LIMIT 25",
        (lower,))]

    identities = []
    if treasury_row:
        identities.append({"type": "treasury", "detail": treasury_row["label"],
                           "confidence": treasury_row["confidence"]})
    for m in managers:
        identities.append({"type": "node-operator", "detail": f"{m['kind']} manager",
                           "confidence": "identified", "manager": m["address"], "manager_kind": m["kind"]})
    if holder_row:
        identities.append({"type": f"{holder_row['venue']}-holder", "detail": holder_row["cex_guess"] or "",
                           "confidence": holder_row["confidence"]})
    if anchor:
        identities.append({"type": "cex-anchor", "detail": anchor["exchange"], "confidence": "identified"})
    if cluster:
        identities.append({"type": "cex-clustered", "detail": f"{cluster['exchange']} score {cluster['score']:.2f}",
                           "confidence": "clustered"})
    return {
        "address": lower,
        "native_balance_raw": native_raw,
        "wrbnt_balance_raw": wrbnt_raw,
        "identities": identities or [{"type": "unknown", "detail": "not otherwise identified",
                                      "confidence": "unconfirmed"}],
        "stats": stats,
        "vestings": vestings,
        "recent_claims": recent_claims,
        "queried_at": now,
    }


# ---------- Page 4: cex ----------

class AnchorIn(BaseModel):
    exchange: str
    address: str


@app.get("/api/cex")
def cex_list():
    market = db.one("SELECT * FROM market_snapshots ORDER BY ts DESC LIMIT 1")
    anchors = db.q("SELECT * FROM cex_anchors ORDER BY added_at DESC")
    clusters = db.q("SELECT * FROM cex_clusters ORDER BY score DESC LIMIT 200")
    volume_share = [dict(r) for r in db.q(
        "SELECT * FROM cex_volume_share ORDER BY volume_usd DESC")]
    latest_snap = db.one("SELECT MAX(snapshot_at) AS s FROM top_holders")
    cex_holders = []
    if latest_snap and latest_snap["s"]:
        cex_holders = [dict(r) for r in db.q(
            "SELECT * FROM top_holders WHERE snapshot_at=? AND venue='cex' ORDER BY rank",
            (latest_snap["s"],))]
    return {"market": dict(market) if market else None,
            "anchors": [dict(a) for a in anchors],
            "clusters": [dict(c) for c in clusters],
            "volume_share": volume_share,
            "volume_note": "24h volume share per venue from CoinGecko tickers - market cap is token-wide and does not split by venue",
            "cex_holders": cex_holders}


@app.post("/api/admin/anchors")
def add_anchor(a: AnchorIn):
    import re
    if not re.fullmatch(r"0x[0-9a-fA-F]{40}", a.address):
        raise HTTPException(400, "address must be a 42-char hex string")
    from web3 import Web3
    db.ex("""INSERT OR REPLACE INTO cex_anchors(exchange,address,source,confidence,added_at)
             VALUES(?,?,?,?,?)""", (a.exchange.strip(), a.address.lower(), "manual", "identified", int(time.time())))
    return {"ok": True}


@app.delete("/api/admin/anchors/{exchange}/{address}")
def del_anchor(exchange: str, address: str):
    db.ex("DELETE FROM cex_anchors WHERE exchange=? AND address=?", (exchange, address.lower()))
    return {"ok": True}


# ---------- Page 5: mega view ----------

@app.get("/api/mega")
def mega():
    latest_snap = db.one("SELECT MAX(snapshot_at) AS s FROM top_holders")
    merged = {}
    if latest_snap and latest_snap["s"]:
        for r in db.q("SELECT * FROM top_holders WHERE snapshot_at=? ORDER BY rank", (latest_snap["s"],)):
            w = r["wallet"]
            e = merged.setdefault(w, {"wallet": w, "balance_raw": 0,
                                      "venues": set(), "confidence": r["confidence"],
                                      "cex": r["cex_guess"]})
            e["balance_raw"] = max(int(e["balance_raw"]), int(r["balance_raw"]))
            e["venues"].add(r["venue"])
    board = [{"wallet": e["wallet"], "balance_raw": str(e["balance_raw"]),
              "venues": sorted(e["venues"]), "confidence": e["confidence"], "cex": e["cex"]}
             for e in sorted(merged.values(), key=lambda x: -x["balance_raw"])[:150]]
    # combined impact: pool interval moves vs CEX price moves within same window.
    # Only interval rows carry real bps; swap-attribution rows stay out of this feed.
    combined = db.q("""
        SELECT l.ts, l.pool, l.impact_bps, l.kind, m.price_usd
        FROM large_sells l LEFT JOIN market_snapshots m
          ON ABS(l.ts - m.ts) < 900
        WHERE l.impact_bps IS NOT NULL AND l.kind='interval'
        GROUP BY l.pool, CAST(l.ts / 900 AS INTEGER)
        ORDER BY l.ts DESC LIMIT 60
    """)
    native_sup = db.one("SELECT supply_raw FROM bridged_supply WHERE chain='native'")
    bridged = [dict(r) for r in db.q("SELECT * FROM bridged_supply")]
    return {"top_holders": board,
            "combined_impact": [dict(r) for r in combined],
            "bridged_supply": bridged}


# ---------- system ----------

@app.get("/api/system")
def system():
    runs = db.q("SELECT * FROM job_runs ORDER BY started_at DESC LIMIT 30")
    counts = {}
    for t in ("managers", "recipients", "claims", "vestings", "treasury",
              "pools", "large_sells", "top_holders"):
        try:
            counts[t] = db.one(f"SELECT COUNT(*) AS c FROM {t}")["c"]
        except Exception:
            counts[t] = None
    return {"schedule": SCHEDULE, "recent_runs": [dict(r) for r in runs], "row_counts": counts}


@app.get("/")
def index():
    return FileResponse("static/index.html")


app.mount("/", StaticFiles(directory="static", html=True), name="static")
