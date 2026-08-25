import time
from web3 import Web3
from web3.providers import HTTPProvider
from web3.middleware import ExtraDataToPOAMiddleware

from config import RPC_URL

_w3 = Web3(HTTPProvider(RPC_URL, request_kwargs={"timeout": 30}))
# Redbelly is PoA/IBFT: validator set blobs exceed the 32-byte extraData assumption
_w3.middleware_onion.inject(ExtraDataToPOAMiddleware, layer=0)


def w3():
    return _w3


def latest_block():
    return _w3.eth.block_number


def call(contract, fn_name, args=()):
    return getattr(contract.functions, fn_name)(*args).call()


def get_contract(address, abi):
    return _w3.eth.contract(address=Web3.to_checksum_address(address), abi=abi)


def get_logs_chunked(address, topics, from_block, to_block, chunk=900, max_retries=4):
    """Yield log dicts, paginating block ranges to respect node limits (this
    node caps eth_getLogs ranges around ~1000 blocks)."""
    out = []
    start = from_block
    addr = Web3.to_checksum_address(address) if address else None
    # node only serves logs for finalized blocks: clamp away from head
    try:
        safe_head = _w3.eth.block_number - 1600
        to_block = min(to_block, max(1, safe_head))
    except Exception:
        pass
    if start > to_block:
        return out
    while start <= to_block:
        tries = 0
        chunk_here = chunk
        while True:
            end = min(start + chunk_here - 1, to_block)
            try:
                logs = _w3.eth.get_logs({
                    "fromBlock": start, "toBlock": end,
                    "address": addr, "topics": topics,
                })
                out.extend(logs)
                break
            except Exception as e:
                msg = str(e).lower()
                if ("too large" in msg or "block range" in msg or "range" in msg):
                    if chunk_here <= 1:
                        raise
                    chunk_here = max(1, chunk_here // 4)
                    continue
                tries += 1
                if tries > max_retries:
                    raise
                time.sleep(2 * tries)
        # remember a working size for the next outer chunk
        chunk = max(chunk_here, min(900, int(chunk_here * 2)))
        start = end + 1
    return out


ERC20_ABI = [
    {"name": "balanceOf", "type": "function", "stateMutability": "view",
     "inputs": [{"name": "a", "type": "address"}],
     "outputs": [{"name": "", "type": "uint256"}]},
    {"name": "totalSupply", "type": "function", "stateMutability": "view",
     "inputs": [], "outputs": [{"name": "", "type": "uint256"}]},
    {"name": "decimals", "type": "function", "stateMutability": "view",
     "inputs": [], "outputs": [{"name": "", "type": "uint8"}]},
    {"name": "getReserves", "type": "function", "stateMutability": "view",
     "inputs": [], "outputs": [{"components": [{"name": "reserve0", "type": "uint112"},
                                               {"name": "reserve1", "type": "uint112"},
                                               {"name": "blockTimestampLast", "type": "uint32"}],
                                "name": "", "type": "tuple"}]},
    {"name": "token0", "type": "function", "stateMutability": "view",
     "inputs": [], "outputs": [{"name": "", "type": "address"}]},
    {"name": "token1", "type": "function", "stateMutability": "view",
     "inputs": [], "outputs": [{"name": "", "type": "address"}]},
]
