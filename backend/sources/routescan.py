import time
import requests

from config import ROUTESCAN_API


def api(params, retries=5):
    params = dict(params)
    for attempt in range(retries):
        try:
            r = requests.get(ROUTESCAN_API, params=params, timeout=30)
            j = r.json()
            if j.get("status") == "1" or j.get("message") == "No transactions found":
                return j.get("result")
            if r.status_code in (429, 502, 503, 504):
                time.sleep(1.5 * (attempt + 1))
                continue
            if "status" not in j and "result" in j:
                return j["result"]  # raw JSON-RPC passthrough (module=proxy)
            raise RuntimeError(f"routescan error: {j}")
        except (requests.RequestException, ValueError) as e:
            if attempt == retries - 1:
                raise
            time.sleep(1.5 * (attempt + 1))


def tokentx_page(address, contractaddress=None, page=1, offset=1000, sort="asc", startblock=0, endblock=99999999):
    p = {"module": "account", "action": "tokentx", "address": address,
         "page": page, "offset": offset, "sort": sort,
         "startblock": startblock, "endblock": endblock}
    if contractaddress:
        p["contractaddress"] = contractaddress
    return api(p)


def tokentx_all(address, contractaddress=None, sort="asc", startblock=0):
    """Generator over all token transfers, handling pagination."""
    page = 1
    seen = 0
    while True:
        rows = tokentx_page(address, contractaddress, page=page, offset=1000, sort=sort, startblock=startblock)
        if not rows:
            return
        yield from rows
        seen += len(rows)
        if len(rows) < 1000:
            return
        page += 1


def tokenholderlist(contractaddress, page=1, offset=100):
    return api({"module": "token", "action": "tokenholderlist",
                "contractaddress": contractaddress, "page": page, "offset": offset})


def getabi(address):
    return api({"module": "contract", "action": "getabi", "address": address})
