"""Chain-wide WRBNT Transfer ingestion.

Backbone for:
- DEX pool discovery (frequent counterparties -> getReserves probe)
- CEX clustering (anchor inflows)
- Sell signals (outbound transfers from claimant wallets)

Stores aggregated edges + a rolling raw window. Incremental by checkpoint.
"""
import time
from collections import defaultdict

from web3 import Web3

import db
from sources.rpc import w3, latest_block, get_logs_chunked
from config import WRBNT, TOPIC_TRANSFER


def _topic_hex(t):
    return "0x" + t.hex() if isinstance(t, bytes) else t


def _addr_from_topic(t):
    h = _topic_hex(t)
    return "0x" + h[-40:]


def sync(max_chunks=None):
    t0 = time.time()
    latest = latest_block()
    key = "wrnt_transfer_scan_block"
    start = int(db.meta_get(key) or 1)
    if start > latest:
        return 0, "caught up", 0.0
    added = 0
    lo = start
    n_calls = 0
    batch_edges = defaultdict(lambda: [0, 0])
    while lo <= latest:
        hi = min(lo + 20000 - 1, latest)
        try:
            logs = get_logs_chunked(WRBNT.lower(), [TOPIC_TRANSFER], lo, hi)
        except Exception:
            db.meta_set(key, lo)  # checkpoint before surfacing the error
            raise
        rows = []
        for lg in logs:
            frm = _addr_from_topic(lg["topics"][1]).lower()
            to = _addr_from_topic(lg["topics"][2]).lower()
            val = str(int.from_bytes(bytes(lg["data"]), "big"))
            rows.append((lg["blockNumber"], frm, to, val))
            batch_edges[(frm, to)][0] += 1
            batch_edges[(frm, to)][1] += int(val)
            added += 1
        if rows:
            ts_lo = _block_ts(lo)
            ts_hi = _block_ts(hi)
            span = max(1, hi - lo)
            slope = (ts_hi - ts_lo) / span
            out = [(b, int(ts_lo + (b - lo) * slope), f, t, v) for b, f, t, v in rows]
            db.exmany("""INSERT OR IGNORE INTO transfers_raw(block,ts,frm,to_addr,value_raw)
                         VALUES(?,?,?,?,?)""", out)
        db.meta_set(key, hi + 1)
        lo = hi + 1
        n_calls += 1
        if max_chunks and n_calls >= max_chunks:
            break
    edge_rows = [(f, t, c, str(v)) for (f, t), (c, v) in batch_edges.items()]
    for f, t, c, v in edge_rows:
        prev = db.one("SELECT tx_count, volume_raw FROM transfer_edges WHERE frm=? AND to_addr=?", (f, t))
        if prev:
            db.ex("""UPDATE transfer_edges SET tx_count=?, volume_raw=? WHERE frm=? AND to_addr=?""",
                  (prev["tx_count"] + c, str(int(prev["volume_raw"]) + int(v)), f, t))
        else:
            db.ex("INSERT INTO transfer_edges(frm,to_addr,tx_count,volume_raw) VALUES(?,?,?,?)", (f, t, c, v))
    return added, f"added={added} blocks_scanned={lo-start}", time.time() - t0


_block_time_cache = {}


def _block_ts(b):
    if b in _block_time_cache:
        return _block_time_cache[b]
    blk = w3().eth.get_block(b)
    ts = blk["timestamp"]
    if len(_block_time_cache) > 5000:
        _block_time_cache.clear()
    _block_time_cache[b] = ts
    return ts


def _insert_rows_with_times(rows):
    """Insert raw transfers with interpolated timestamps (per-block exact,
    interpolated within gaps using linear fit between sampled anchors)."""
    out = []
    last_b = last_t = None
    pending = []
    for b, frm, to, val in sorted(rows, key=lambda r: r[0]):
        ts = _block_time_cache.get(b)
        if ts is None:
            ts = _block_ts(b)
        out.append((b, ts, frm, to, val))
    db.exmany("""INSERT OR IGNORE INTO transfers_raw(block,ts,frm,to_addr,value_raw)
                 VALUES(?,?,?,?,?)""", out)
