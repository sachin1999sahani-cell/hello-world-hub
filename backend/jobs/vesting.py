import json
import time

from web3 import Web3

import db
from sources.rpc import get_contract
from jobs.recipients import _abi


def _decode_vesting(fields):
    """vestingById returns 11 fields. Verified semantics (probe vs tokentx):
    0 recipient | 1 startTs | 2 endTs | 3 timelock | 4 cliffReleaseTs |
    5 flag(uint32) | 6 revocation-ish ts (0 when active) |
    7 initialUnlock | 8 cliffAmount | 9 linearVestAmount | 10 alreadyClaimed"""
    f = [str(x) for x in fields]
    return {
        "wallet": Web3.to_checksum_address(f[0]).lower(),
        "start_ts": int(f[1]), "end_ts": int(f[2]), "timelock": int(f[3]),
        "cliff_release_ts": int(f[4]),
        "flag5": int(f[5]), "revoked_or_6": int(f[6]),
        "initial_unlock_raw": str(int(f[7])),
        "cliff_amount_raw": str(int(f[8])),
        "linear_amount_raw": str(int(f[9])),
        "claimed_raw": str(int(f[10])),
    }


def vested_estimate(v, now=None):
    """Linear accrual estimate from schedule params. Caveat applies: jailing can
    extend vesting, tombstoning forfeits unvested - actual contract state wins."""
    now = now or int(time.time())
    alloc = int(v["initial_unlock_raw"]) + int(v["cliff_amount_raw"]) + int(v["linear_amount_raw"])
    if now <= v["start_ts"]:
        return min(int(v["initial_unlock_raw"]), alloc)
    if now >= v["end_ts"]:
        return alloc
    frac = (now - v["start_ts"]) / max(1, (v["end_ts"] - v["start_ts"]))
    est = int(v["linear_amount_raw"]) * frac + int(v["initial_unlock_raw"]) + int(v["cliff_amount_raw"])
    return min(int(est), alloc)


def sync_manager_vestings(manager_addr, max_new=2000):
    """Discover new vesting IDs per recipient and decode them. Existing IDs are
    refreshed opportunistically (claimed amount moves). Returns counts."""
    c = get_contract(manager_addr, _abi())
    wallets = [r["wallet"] for r in db.q("SELECT wallet FROM recipients WHERE manager=?", (manager_addr,))]
    known = {r["vesting_id"]: r for r in db.q("SELECT vesting_id FROM vestings WHERE manager=?", (manager_addr,))}
    now = int(time.time())
    new_ids = []
    per_wallet = {}
    for w in wallets:
        cs = Web3.to_checksum_address(w)
        try:
            ids = c.functions.getAllRecipientVestings(cs).call()
        except Exception:
            continue
        per_wallet[w] = ids
        for vid in ids:
            key = vid.hex() if isinstance(vid, bytes) else str(vid)
            if key not in known:
                new_ids.append((key, w))
    # window labels: rank by start_ts within (manager, wallet)
    decoded = []
    for key, w in new_ids[:max_new]:
        try:
            fields = c.functions.vestingById(bytes.fromhex(key[2:] if key.startswith("0x") else key)).call()
        except TypeError:
            fields = c.functions.vestingById(key).call()
        v = _decode_vesting(fields)
        decoded.append((manager_addr.lower(), key, v))
    rows = []
    for mgr, key, v in decoded:
        state = classify_state(v, now)
        rows.append((
            mgr, key, v["wallet"], json.dumps(v),
            v["start_ts"], v["end_ts"], v["timelock"],
            v["initial_unlock_raw"], v["cliff_release_ts"], v["cliff_amount_raw"],
            v.get("interval_secs"), v["linear_amount_raw"], v["claimed_raw"],
            1 if v["revoked_or_6"] else 0, None, state, now))
    if rows:
        db.exmany("""INSERT INTO vestings(manager,vesting_id,wallet,raw_json,start_ts,end_ts,timelock,
                     initial_unlock_raw,cliff_release_ts,cliff_amount_raw,interval_secs,
                     linear_amount_raw,released_or_claimed_raw,revoked,window_label,state,updated_at)
                     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                     ON CONFLICT(manager,vesting_id) DO UPDATE SET
                       released_or_claimed_raw=excluded.released_or_claimed_raw,
                       revoked=excluded.revoked, state=excluded.state, updated_at=excluded.updated_at""",
                  [(r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7], r[8], r[9], r[10],
                    r[11], r[12], r[13], r[14], r[15], r[16]) for r in rows])
    assign_window_labels(manager_addr)
    return len(new_ids), len(decoded)


def classify_state(v, now):
    alloc = int(v["initial_unlock_raw"]) + int(v["cliff_amount_raw"]) + int(v["linear_amount_raw"])
    claimed = int(v["claimed_raw"])
    if v["revoked_or_6"]:
        return "holding" if claimed > 0 else "not_claimed"
    if claimed >= alloc > 0:
        return "claimed"
    if claimed == 0:
        return "holding" if vested_estimate(v, now) > 0 else "not_claimed"
    return "holding"


def assign_window_labels(manager_addr):
    """Label each wallet's windows part1/part2/... ordered by start time."""
    rows = db.q("""SELECT vesting_id, wallet, start_ts FROM vestings WHERE manager=?
                   ORDER BY wallet, start_ts, vesting_id""", (manager_addr,))
    labels = {}
    for r in rows:
        n = labels.get(r["wallet"], 0) + 1
        labels[r["wallet"]] = n
        db.ex("UPDATE vestings SET window_label=? WHERE manager=? AND vesting_id=?",
              (f"part{n}", manager_addr, r["vesting_id"]))


def run(managers=None):
    t0 = time.time()
    if managers is None:
        managers = [r["address"] for r in db.q("SELECT address FROM managers")]
    detail = []
    for m in managers:
        try:
            new, dec = sync_manager_vestings(m)
            detail.append(f"{m[:10]}:+{dec}")
        except Exception as e:
            detail.append(f"{m[:10]}:ERR {str(e)[:60]}")
    return len(managers), "; ".join(detail), time.time() - t0
