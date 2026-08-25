import os
import time

import requests

import db
from sources.rpc import get_contract
from config import COINGECKO_IDS, BRIDGED_WRBNT

ERC20_ABI = [
    {"name": "totalSupply", "type": "function", "stateMutability": "view",
     "inputs": [], "outputs": [{"name": "", "type": "uint256"}]},
]

SOLANA_RPC = "https://api.mainnet-beta.solana.com"
SOL_MINT = "2GBVt2ENvbHepuJMWYTPkkfpWUabAhsaXToYw8UphxS3"


def market():
    t0 = time.time()
    price = supply = cap = None
    try:
        headers = {}
        demo_key = os.environ.get("COINGECKO_DEMO_KEY") or os.environ.get("CG_DEMO_KEY")
        if demo_key:
            headers["x-cg-demo-api-key"] = demo_key
        r = requests.get("https://api.coingecko.com/api/v3/simple/price",
                         params={"ids": ",".join(COINGECKO_IDS), "vs_currencies": "usd",
                                 "include_market_cap": "true", "include_24hr_vol": "true"},
                         timeout=15, headers=headers)
        j = r.json()
        d = j.get(COINGECKO_IDS[0], {})
        price = d.get("usd")
        cap = d.get("usd_market_cap")
    except Exception as e:
        return 0, f"coingecko error: {e}", time.time() - t0
    # circulating supply derived from CG market cap when price present
    if price and cap:
        supply = cap / price
    db.ex("INSERT OR REPLACE INTO market_snapshots(ts,price_usd,circulating_supply,market_cap,source) VALUES(?,?,?,?,?)",
          (int(time.time()), price, supply, cap, "coingecko"))
    return 1, f"price={price} cap={cap}", time.time() - t0


def venue_volume_share():
    """24h volume per exchange from CoinGecko tickers for RBNT. Market cap is
    token-wide and never splits by venue; volume share is the honest breakdown."""
    t0 = time.time()
    try:
        headers = {}
        demo_key = os.environ.get("COINGECKO_DEMO_KEY") or os.environ.get("CG_DEMO_KEY")
        if demo_key:
            headers["x-cg-demo-api-key"] = demo_key
        r = requests.get(f"https://api.coingecko.com/api/v3/coins/{COINGECKO_IDS[0]}/tickers",
                         params={"include_exchange_btn": "false"}, timeout=20, headers=headers)
        j = r.json()
        tickers = j.get("tickers", [])
    except Exception as e:
        return 0, f"tickers error: {e}", time.time() - t0
    agg = {}
    for t in tickers:
        m = t.get("market") or {}
        ident = (m.get("identifier") or "?").lower()
        name = m.get("name") or ident
        vol = ((t.get("converted_volume") or {}).get("usd")) or 0
        key = ident if len(ident) <= 24 else ident[:24]
        e = agg.setdefault(key, {"name": name, "vol": 0.0})
        e["vol"] += float(vol)
    now = int(time.time())
    for ident, e in agg.items():
        db.ex("""INSERT INTO cex_volume_share(exchange,volume_usd,updated_at) VALUES(?,?,?)
                 ON CONFLICT(exchange) DO UPDATE SET volume_usd=excluded.volume_usd,
                   updated_at=excluded.updated_at""", (ident, round(e["vol"], 2), now))
    return len(agg), f"venues={len(agg)} tickers={len(tickers)}", time.time() - t0


def bridged():
    t0 = time.time()
    ok = 0
    # native-chain WRBNT supply first (ground truth for reconciliation panel)
    try:
        from web3 import Web3
        c = get_contract("0x6ed1F491e2d31536D6561f6bdB2AdC8F092a6076", ERC20_ABI)
        sup = str(c.functions.totalSupply().call())
        db.ex("""INSERT INTO bridged_supply(chain,address,supply_raw,reachable,updated_at)
                 VALUES('native',?,?,?,?,1) ON CONFLICT(chain) DO UPDATE SET
                   supply_raw=excluded.supply_raw, reachable=1, updated_at=excluded.updated_at""",
              ("0x6ed1f491e2d31536d6561f6bdb2adc8f092a6076", sup, int(time.time())))
        ok += 1
    except Exception:
        pass
    for chain, addr, rpcs in BRIDGED_WRBNT:
        sup = None
        for rpc in rpcs:
            try:
                from web3 import Web3
                from web3.middleware import ExtraDataToPOAMiddleware
                from web3.providers import HTTPProvider
                w = Web3(HTTPProvider(rpc, request_kwargs={"timeout": 20}))
                c = w.eth.contract(address=Web3.to_checksum_address(addr), abi=ERC20_ABI)
                sup = str(c.functions.totalSupply().call())
                break
            except Exception:
                continue
        if sup is not None:
            db.ex("""INSERT INTO bridged_supply(chain,address,supply_raw,reachable,updated_at)
                     VALUES(?,?,?,?,?)
                     ON CONFLICT(chain) DO UPDATE SET supply_raw=excluded.supply_raw,
                       reachable=1, address=excluded.address, updated_at=excluded.updated_at""",
                  (chain, addr.lower(), sup, 1, int(time.time())))
            ok += 1
        else:
            db.ex("""INSERT INTO bridged_supply(chain,address,supply_raw,reachable,updated_at)
                     VALUES(?,?,NULL,0,?)
                     ON CONFLICT(chain) DO UPDATE SET reachable=0, updated_at=excluded.updated_at""",
                  (chain, addr.lower(), int(time.time())))
    # solana best effort
    try:
        r = requests.post(SOLANA_RPC, json={"jsonrpc": "2.0", "id": 1, "method": "getTokenSupply",
                                            "params": [SOL_MINT]}, timeout=15).json()
        sup = r["result"]["uiAmountString"]
        db.ex("""INSERT INTO bridged_supply(chain,address,supply_raw,reachable,updated_at)
                 VALUES('solana',?,?,?,?,1) ON CONFLICT(chain) DO UPDATE SET supply_raw=excluded.supply_raw,
                   reachable=1, updated_at=excluded.updated_at""",
              (SOL_MINT.lower(), str(int(float(sup) * 1e6)), int(time.time()),))
        ok += 1
    except Exception:
        db.ex("""INSERT INTO bridged_supply(chain,address,supply_raw,reachable,updated_at)
                 VALUES('solana',?,NULL,0,?) ON CONFLICT(chain) DO UPDATE SET reachable=0,
                   updated_at=excluded.updated_at""", (SOL_MINT.lower(), int(time.time())))
    return ok, f"bridged_ok={ok}", time.time() - t0
