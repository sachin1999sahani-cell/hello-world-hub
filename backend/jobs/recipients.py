import time
from web3 import Web3

import db
from sources.rpc import get_contract, call
from config import DB_PATH  # noqa: F401

ABI = None


def _abi():
    global ABI
    if ABI is None:
        import json, os
        p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "abis", "token_vesting_manager.json")
        ABI = json.load(open(p))
    return ABI


def sync_recipients(manager_addr, batch_size=400):
    """Refresh the recipient roster for one manager. Returns (total, added)."""
    c = get_contract(manager_addr, _abi())
    total = int(call(c, "getAllRecipientsLength"))
    existing = {r["wallet"] for r in db.q("SELECT wallet FROM recipients WHERE manager=?", (manager_addr.lower(),))}
    now = int(time.time())
    added = 0
    # try full read first; fall back to slices
    recips = []
    try:
        recips = call(c, "getAllRecipients")
        if len(recips) < total:
            raise ValueError("truncated")
    except Exception:
        recips = []
        start = 0
        while start < total:
            cnt = min(batch_size, total - start)
            part = call(c, "getAllRecipientsSliced", [start, cnt])
            recips.extend(part)
            start += cnt
    rows = []
    for r in recips:
        w = Web3.to_checksum_address(r).lower()
        if w not in existing:
            rows.append((manager_addr.lower(), w, now))
            added += 1
    if rows:
        db.exmany("INSERT OR IGNORE INTO recipients(manager,wallet,added_at) VALUES(?,?,?)", rows)
    db.ex("UPDATE managers SET recipients_cached=?, last_roster_sync=? WHERE address=?",
          (total, now, manager_addr.lower()))
    return total, added


def sync_all(limit=None):
    t0 = time.time()
    managers = [r["address"] for r in db.q("SELECT address FROM managers ORDER BY kind, recipients_cached")]
    if limit:
        managers = managers[:limit]
    detail = []
    for m in managers:
        try:
            total, added = sync_recipients(m)
            detail.append(f"{m[:10]}:{total}(+{added})")
        except Exception as e:
            detail.append(f"{m[:10]}:ERR {e}")
    return len(managers), "; ".join(detail), time.time() - t0
