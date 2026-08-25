import time

import db
from sources import routescan
from sources.rpc import latest_block, get_logs_chunked
from config import SIGNUP_FACTORY, RETENTION_FACTORY, FACTORY_CREATION_TOPIC


def _creations_from_txlist(factory):
    """New deployments show up as newTokenVestingManager calls on the factory.
    Returns list of (block, tx_hash)."""
    out = []
    page = 1
    while True:
        rows = routescan.api({"module": "account", "action": "txlist", "address": factory,
                              "page": page, "offset": 1000, "sort": "asc"})
        if not rows:
            break
        for t in rows:
            fn = t.get("functionName") or ""
            if "newTokenVestingManager" in fn:
                out.append((int(t["blockNumber"]), t["hash"]))
        if len(rows) < 1000:
            break
        page += 1
    return out


def _manager_for_block(factory, block, topic):
    """Creation events carry the created manager as an address word in data.
    Signup factory: single word. Retention factory: several words, manager first.
    Take the first nonzero address-sized word."""
    logs = get_logs_chunked(factory.lower(), [topic], block, block)
    out = []
    for lg in logs:
        h = lg["data"].hex().removeprefix("0x")
        addr = None
        for i in range(0, len(h) - 63, 64):
            w = h[i:i + 64]
            if any(w):
                addr = "0x" + w[-40:]
                break
        if addr is None and len(lg["topics"]) > 1:
            addr = "0x" + lg["topics"][1].hex()[-40:]
        if addr:
            ts = int(lg.get("blockTimestamp") or "0", 16) or None
            out.append((addr, ts))
    return out


def discover_managers():
    """Fast discovery: factory txlist + per-tx log lookup. New deployments
    surface as newTokenVestingManager calls on either factory."""
    t0 = int(time.time())
    latest = latest_block()
    found = []
    for kind, factory in (("signup", SIGNUP_FACTORY), ("retention", RETENTION_FACTORY)):
        topic = FACTORY_CREATION_TOPIC[kind]
        seen = {r["address"] for r in db.q("SELECT address FROM managers WHERE kind=?", (kind,))}
        last_tx_block = int(db.meta_get(f"managers_txblock_{kind}") or 0)
        for block, txh in _creations_from_txlist(factory):
            if block <= last_tx_block:
                continue
            for addr, ts in _manager_for_block(factory, block, topic):
                if addr.lower() not in seen:
                    found.append((addr.lower(), factory.lower(), kind, block, ts))
        db.meta_set(f"managers_txblock_{kind}", latest)
    db.exmany("""INSERT INTO managers(address,factory,kind,created_block,created_at)
                 VALUES(?,?,?,?,?)
                 ON CONFLICT(address) DO NOTHING""",
              [(a, f, k, b, ts or int(time.time())) for a, f, k, b, ts in found])
    return len(found), f"new={len(found)} total={db.one('SELECT COUNT(*) c FROM managers')['c']}"
