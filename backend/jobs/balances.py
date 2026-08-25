import time
from web3 import Web3

import db
from sources.rpc import get_contract
from jobs.recipients import _abi

WRBNT_ABI = [
    {"name": "balanceOf", "type": "function", "stateMutability": "view",
     "inputs": [{"name": "", "type": "address"}],
     "outputs": [{"name": "", "type": "uint256"}]},
]


def refresh_balances(limit=800):
    """Poll WRBNT balances for tracked claimant wallets; derive sold-proxy signal.

    sold proxy = claimed_total - current_balance (>=0). Honest caveat in UI:
    ignores external inflows, so treat as lower-bound sell estimate.
    """
    t0 = time.time()
    w3 = get_contract("0x6ed1F491e2d31536D6561f6bdB2AdC8F092a6076", WRBNT_ABI)
    rows = db.q("""SELECT wallet, claimed_total_raw FROM address_stats
                   ORDER BY length(claimed_total_raw) DESC, claimed_total_raw DESC LIMIT ?""", (limit,))
    now = int(time.time())
    updates = []
    for r in rows:
        try:
            bal = w3.functions.balanceOf(Web3.to_checksum_address(r["wallet"])).call()
        except Exception:
            continue
        claimed = int(r["claimed_total_raw"])
        sold = max(0, claimed - bal)
        score = round(sold / claimed, 4) if claimed > 0 else 0.0
        prev_ts = db.one("SELECT balance_updated_at FROM address_stats WHERE wallet=?", (r["wallet"],))
        last_signal = None
        if prev_ts and prev_ts["balance_updated_at"]:
            old = db.one("SELECT balance_raw FROM address_stats WHERE wallet=?", (r["wallet"],))
            if old and old["balance_raw"] and bal < int(old["balance_raw"]) * 0.9:
                last_signal = now
        updates.append((str(bal), now, score, last_signal, r["wallet"]))
    db.exmany("""UPDATE address_stats SET balance_raw=?, balance_updated_at=?,
                 sell_signal_score=?, last_sell_signal_ts=COALESCE(?, last_sell_signal_ts)
                 WHERE wallet=?""", updates)

    # outbound-transfer signal: claimant wallets that shipped WRBNT recently
    cutoff = now - 7 * 86400
    known_contracts = {r["to_addr"] for r in db.q(
        """SELECT DISTINCT to_addr FROM transfer_edges WHERE tx_count >= 20""")}
    flagged = db.q("""SELECT DISTINCT frm FROM transfers_raw
                      WHERE ts>? AND frm IN (SELECT wallet FROM address_stats)
                        AND to_addr NOT IN (SELECT wallet FROM recipients)""",
                   (cutoff,))
    n_flag = 0
    for r in flagged:
        w = r["frm"]
        # exclude sends into known infrastructure; treat the rest as sell-side flow
        dests = db.q("SELECT DISTINCT to_addr FROM transfers_raw WHERE frm=? AND ts>?", (w, cutoff))
        if any(d["to_addr"] not in known_contracts for d in dests):
            db.ex("""UPDATE address_stats SET last_sell_signal_ts=?
                     WHERE wallet=? AND (last_sell_signal_ts IS NULL OR last_sell_signal_ts<?)""",
                  (now, w, now))
            n_flag += 1
    return len(updates), f"polled={len(updates)} flagged={n_flag}", time.time() - t0
