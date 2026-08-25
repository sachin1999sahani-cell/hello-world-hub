import json
import time
from collections import defaultdict

from web3 import Web3

import db
from sources import routescan
from sources.rpc import w3, latest_block, get_logs_chunked
from config import USDC_E, WRBNT

PAIR_ABI = [
    {"name": "getReserves", "type": "function", "stateMutability": "view",
     "inputs": [], "outputs": [{"name": "", "type": "uint112"}, {"name": "", "type": "uint112"},
                               {"name": "", "type": "uint32"}]},
    {"name": "token0", "type": "function", "stateMutability": "view",
     "inputs": [], "outputs": [{"name": "", "type": "address"}]},
    {"name": "token1", "type": "function", "stateMutability": "view",
     "inputs": [], "outputs": [{"name": "", "type": "address"}]},
]

# Common V2-style Swap signature (Reddex may differ; reserves-delta fallback covers that)
TOPIC_SWAP_V2 = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822"

KNOWN_EXCLUDE = {
    WRBNT.lower(), USDC_E.lower(),
    "0xbcee2defb7cf136480e3619cf93e8129059977af",
}


REDEX_FACTORY = "0x262E06314Af8f4EEd70dbd8C7EFe2a5De686C142"
STABLES = {USDC_E.lower(), "0x8c4acd74ff4385f3b7911432fa6787aa14406f8b"}  # USDC.e, USDT

FACTORY_ABI = [
    {"name": "allPairsLength", "type": "function", "stateMutability": "view",
     "inputs": [], "outputs": [{"name": "", "type": "uint256"}]},
    {"name": "allPairs", "type": "function", "stateMutability": "view",
     "inputs": [{"name": "", "type": "uint256"}], "outputs": [{"name": "", "type": "address"}]},
]
TOKEN_ABI = [
    {"name": "symbol", "type": "function", "stateMutability": "view",
     "inputs": [], "outputs": [{"name": "", "type": "string"}]},
    {"name": "decimals", "type": "function", "stateMutability": "view",
     "inputs": [], "outputs": [{"name": "", "type": "uint8"}]},
]


def discover_pools(top_candidates=40):
    """Authoritative discovery: enumerate every Reddex pair from the factory
    (verified on Routescan, exposes allPairs). Each candidate is checked for
    getReserves in standard shape before it is stored. Falls back to probing
    frequent WRBNT counterparties only if the factory is unreachable."""
    t0 = int(time.time())
    now = int(time.time())
    found = []
    try:
        fc = w3().eth.contract(address=Web3.to_checksum_address(REDEX_FACTORY), abi=FACTORY_ABI)
        n = fc.functions.allPairsLength().call()
        for i in range(n):
            addr = fc.functions.allPairs(i).call()
            try:
                pc = w3().eth.contract(address=addr, abi=PAIR_ABI)
                r0, r1, _ = pc.functions.getReserves().call()
                tk0 = pc.functions.token0().call()
                tk1 = pc.functions.token1().call()
            except Exception:
                continue  # not V2-shaped; skip honestly
            s0 = w3().eth.contract(address=tk0, abi=TOKEN_ABI)
            s1 = w3().eth.contract(address=tk1, abi=TOKEN_ABI)
            try:
                sym0 = s0.functions.symbol().call()
                d0 = s0.functions.decimals().call()
            except Exception:
                sym0, d0 = "?", 18
            try:
                sym1 = s1.functions.symbol().call()
                d1 = s1.functions.decimals().call()
            except Exception:
                sym1, d1 = "?", 18
            found.append((str(addr), tk0.lower(), tk1.lower(), str(r0), str(r1),
                          sym0, sym1, d0, d1))
        source = "factory"
    except Exception:
        found = []
        source = "discovered"
        nodes = defaultdict(lambda: [0, 0])
        for r in db.q("SELECT * FROM transfer_edges"):
            for party in (r["frm"], r["to_addr"]):
                p = party.lower()
                if p in KNOWN_EXCLUDE:
                    continue
                nodes[p][0] += r["tx_count"]
                nodes[p][1] += int(r["volume_raw"])
        for addr, (cnt, vol) in sorted(nodes.items(), key=lambda kv: -kv[1][1])[:top_candidates]:
            try:
                pc = w3().eth.contract(address=Web3.to_checksum_address(addr), abi=PAIR_ABI)
                r0, r1, _ = pc.functions.getReserves().call()
                tk0 = pc.functions.token0().call().lower()
                tk1 = pc.functions.token1().call().lower()
            except Exception:
                continue
            if {tk0, tk1} & {USDC_E.lower(), WRBNT.lower()}:
                found.append((addr, tk0, tk1, str(r0), str(r1), "?", "?", 18, 6))
    for addr, tk0, tk1, r0, r1, sym0, sym1, d0, d1 in found:
        label = f"{sym0}/{sym1}"
        db.ex("""INSERT INTO pools(address,label,token_a,token_b,reserve_a_raw,reserve_b_raw,
                 decimals_a,decimals_b,symbol_a,symbol_b,source,updated_at)
                 VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
                 ON CONFLICT(address) DO UPDATE SET label=excluded.label,
                   token_a=excluded.token_a, token_b=excluded.token_b,
                   decimals_a=excluded.decimals_a, decimals_b=excluded.decimals_b,
                   symbol_a=excluded.symbol_a, symbol_b=excluded.symbol_b,
                   source=excluded.source""",
              (addr.lower(), label, tk0, tk1, r0, r1, d0, d1, sym0, sym1, source, now))
    return len(found), f"source={source} pools={len(found)}"


def refresh_reserves():
    t0 = time.time()
    now = int(time.time())
    n = 0
    for p in db.q("SELECT * FROM pools"):
        try:
            pc = w3().eth.contract(address=Web3.to_checksum_address(p["address"]), abi=PAIR_ABI)
            r0, r1, _ = pc.functions.getReserves().call()
            tk0 = pc.functions.token0().call().lower()
        except Exception:
            continue
        prev_price = p["price"]
        d_a = p["decimals_a"] or 18
        d_b = p["decimals_b"] or 18
        a_stable = (tk0 or "").lower() in STABLES
        b_stable = (p["token_b"] or "").lower() in STABLES
        price = None
        if int(r0) > 0 and int(r1) > 0:
            if b_stable and not a_stable:
                price = (int(r1) / 10 ** d_b) / (int(r0) / 10 ** d_a)
            elif a_stable and not b_stable:
                price = (int(r0) / 10 ** d_a) / (int(r1) / 10 ** d_b)
        impact_bps = None
        if prev_price and price and prev_price > 0:
            impact_bps = round((price - prev_price) / prev_price * 10000, 1)
        db.ex("""UPDATE pools SET reserve_a_raw=?, reserve_b_raw=?, token_a=?, price=?, updated_at=? WHERE address=?""",
              (str(r0), str(r1), tk0, price, now, p["address"]))
        if impact_bps is not None and abs(impact_bps) >= 50:
            db.ex("""INSERT OR IGNORE INTO large_sells(tx_hash,log_index,pool,seller,rbnt_sold_raw,
                     usdc_received_raw,price_before,price_after,impact_bps,ts)
                     VALUES(?,?,?,?,?,?,?,?,?,?)""",
                  (f"interval-{p['address']}-{now}", 0, p["address"], None, None,
                   None, prev_price, price, impact_bps, now))
        n += 1
    return n, f"pools={n}", time.time() - t0


def scan_swap_events(lookback_blocks=20000):
    """Attributed swaps on all pools (kind=swap): seller + token amount sold.
    Incremental from a block checkpoint; first pass backfills a window.
    USD impact bps stays NULL here; interval rows (stable-priced pools) carry
    price moves so the two kinds never get conflated in the feed."""
    t0 = time.time()
    latest = latest_block()
    key = "swaps_scan_block"
    start = int(db.meta_get(key) or max(1, latest - lookback_blocks))
    if start > latest:
        return 0, "caught up", 0.0
    n = 0
    pool_tokens = {r["address"]: (r["token_a"], r["token_b"],
                                  r["symbol_a"], r["symbol_b"]) for r in db.q("SELECT * FROM pools")}
    lo = start
    while lo <= latest:
        hi = min(lo + 900 - 1, latest)
        try:
            logs = _pool_swaps_range(pool_tokens, lo, hi)
        except Exception:
            db.meta_set(key, lo)
            raise
        n += len(logs)
        db.meta_set(key, hi + 1)
        lo = hi + 1
    return n, f"swaps={n} blocks={latest-start}", time.time() - t0


def _pool_swaps_range(pool_tokens, lo, hi):
    """All swap logs across known pools within [lo, hi]."""
    out = []
    for p, tokens in pool_tokens.items():
        ta, tb, sa, sb = tokens
        try:
            logs = get_logs_chunked(p, [TOPIC_SWAP_V2], lo, hi)
        except Exception:
            continue
        for lg in logs:
            data = lg["data"].hex()
            try:
                # Verified against Routescan ABI: non-indexed params encode in
                # declaration order -> words[0]=amount0In, [1]=amount1In,
                # [2]=amount0Out, [3]=amount1Out
                a0in, a1in, a0out, a1out = (int(data[i:i + 64], 16) for i in (0, 64, 128, 192))
            except Exception:
                continue
            txh = lg.get("transactionHash") or lg.get("hash")
            if isinstance(txh, bytes):
                txh = "0x" + txh.hex()
            seller = ("0x" + lg["topics"][1].hex()[-40:]) if len(lg["topics"]) > 1 else None
            sold_raw = str(a0in) if a0in else (str(a1in) if a1in else None)
            sold_sym = sa if a0in else (sb if a1in else None)
            recv_raw = str(a0out) if a0out else (str(a1out) if a1out else None)
            recv_sym = sa if a0out else (sb if a1out else None)
            db.ex("""INSERT OR IGNORE INTO large_sells(tx_hash,log_index,pool,kind,seller,rbnt_sold_raw,
                     usdc_received_raw,price_before,price_after,impact_bps,ts)
                     VALUES(?,?,?,?,?,?,?,?,?,?,?)""",
                  (str(txh).lower(), lg["logIndex"], p.lower(), "swap", seller,
                   f"{sold_sym}:{sold_raw}" if sold_raw else None,
                   f"{recv_sym}:{recv_raw}" if recv_raw else None,
                   None, None, None, int(time.time())))
            out.append(lg)
    return out
