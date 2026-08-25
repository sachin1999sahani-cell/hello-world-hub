import time

from web3 import Web3
from web3.providers import HTTPProvider

import db
from sources.rpc import w3, get_contract
from config import RPC_URL, TREASURY_WALLETS, WRBNT

ERC20_ABI = [{"name": "balanceOf", "type": "function", "stateMutability": "view",
              "inputs": [{"name": "", "type": "address"}],
              "outputs": [{"name": "", "type": "uint256"}]}]


def seed():
    for label, addr, note, conf in TREASURY_WALLETS:
        db.ex("""INSERT OR IGNORE INTO treasury(label,address,note,confidence) VALUES(?,?,?,?)""",
              (label, addr.lower(), note, conf))


def run():
    t0 = time.time()
    now = int(time.time())
    n = 0
    wrbnt = get_contract(WRBNT, ERC20_ABI)
    for label, addr, note, conf in TREASURY_WALLETS:
        a = Web3.to_checksum_address(addr)
        try:
            native = str(w3().eth.get_balance(a))
            token = str(wrbnt.functions.balanceOf(a).call())
        except Exception:
            continue
        db.ex("""UPDATE treasury SET eth_native_raw=?, rbnt_balance_raw=?, updated_at=?
                 WHERE address=?""",
              (native, token, now, addr.lower()))
        n += 1
    return n, f"wallets={n}", time.time() - t0
