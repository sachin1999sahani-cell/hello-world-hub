# RBNT Analytics Dashboard

Live-updating on-chain analytics for RBNT (Redbelly Network). Python poller + SQLite + FastAPI + static vanilla-JS frontend, styled to the Kinetic Consensus design system (dark + light themes).

## Deploy layouts

### Full stack on one box (recommended, current setup)

The poller is a persistent background scheduler - it needs a real server, not serverless.

    cd backend
    ../.venv/bin/python serve.py          # scheduler + API + site on :8600

Production: `rbnt-analytics.service` systemd unit runs this automatically and restarts on failure. Install with:

    sudo cp deploy/rbnt-analytics.service /etc/systemd/system/
    sudo systemctl daemon-reload && sudo systemctl enable --now rbnt-analytics

### Frontend on Vercel, backend on a VPS

1. Backend stays on a VPS (systemd), reachable over HTTPS.
2. Vercel imports this repo; `vercel.json` serves `backend/static` as a static site.
3. Set the backend origin in `backend/static/index.html`:
       window.API_BASE = "https://your-backend-host.com";
   CORS is already open on the API for this case.
4. Do NOT deploy the poller itself to Vercel - serverless functions cannot keep
   APScheduler alive or hold SQLite state.

## Run locally

    python3 -m venv .venv
    .venv/bin/pip install -r requirements.txt
    cd backend && ../.venv/bin/python serve.py

First-run data appears progressively: treasury and market within seconds, claims history in minutes, vesting records in ~10 minutes, transfer backfill in under an hour.

One-off utilities:

    ../.venv/bin/python poller.py         # blocking initial seed pass only
    ../.venv/bin/python run_seed.py       # roster + claims + vesting seed
    ../.venv/bin/python run_backfill.py   # WRBNT transfer log backfill (recent window)

## Architecture

- `backend/config.py` - addresses, topics, poll cadences
- `backend/sources/rpc.py` - web3 wrapper; adaptive eth_getLogs chunking (node caps ranges near head at roughly 1000-1600 blocks of finality lag), POA middleware for Redbelly's IBFT headers
- `backend/sources/routescan.py` - Etherscan-compatible client with pagination and raw JSON-RPC passthrough
- `backend/jobs/` - one module per dataset:
  - managers: discovers TokenVestingManager deployments from both factories via factory txlist plus per-tx creation logs (signup factory 0x9DB1...B64, retention factory 0x7dac...F1b)
  - recipients / claims / balances / vesting: roster via getAllRecipients(Sliced), claims via WRBNT tokentx where from = manager, per-window state via vestingById field 10 (already-claimed amount, verified against tokentx)
  - transfers: chain-wide WRBNT Transfer ingestion feeding pool discovery, CEX clustering and sell signals
  - native: best-effort native RBNT ranking across all known addresses via eth_getBalance
  - dex: Reddex pools enumerated authoritatively from the verified factory contract (allPairs), symbols/decimals read per token, getReserves shape checked before storing; swap events decoded against the confirmed Uniswap-V2 signature
  - treasury / holders / market (+ CoinGecko venue volume share) / cex
- `backend/poller.py` - APScheduler registration per config.SCHEDULE
- `backend/app.py` - FastAPI read endpoints plus admin anchor management and wallet profile lookup
- `backend/static/` - no-build-step frontend, hash-routed, refreshes every 30s; shared chart module (bars + impact line), orbital section nav, scoped table search

## Verified against the spec reference case

Manager 0x7199D184EE85d738bB347e0B1d53544007C5d7fC is the default primary view: 208 recipients, 188 ever claimed, 5,383+ claim transactions and growing, 29.97M WRBNT total. The 23-manager aggregate sits behind an "All managers" toggle because cross-manager reconciliation is an open item.

## DEX pools

Pools are resolved authoritatively every 30 minutes by enumerating the Reddex factory contract (0x262E06314Af8f4EEd70dbd8C7EFe2a5De686C142, verified on Routescan) via allPairsLength plus allPairs(i). Every candidate must expose getReserves in the standard V2 shape before it is stored; symbols and decimals are read from each token contract. Current factory list: LQDX/USDT, LQDX/WRBNT, WRBNT/USDT, WRBNT/USDC.e, WETH/WRBNT, SNEC/WRBNT, LQDX/USDC.e - matching Reddex's own pool names with no hardcoded addresses.

The DEX page includes a price impact threshold table (-90 percent to +200 percent in 10 percent steps) built from constant product math against live reserves, labeled as a no-fee approximation (real trades add roughly 0.3 percent in fees).

## CoinGecko

RBNT aggregate uses coin id `redbelly-network-token`. Keyless reads work today but rate-limit silently; set COINGECKO_DEMO_KEY in the service environment to send an x-cg-demo-api-key header:

    systemctl edit rbnt-analytics   # add [Service] Environment=COINGECKO_DEMO_KEY=...

## Honest limitations shown in the UI

- Seed/Private-Sale trail is labeled inferred, never confirmed; no fabricated 4-way split.
- CEX hot wallets stay best effort: manual test-deposit anchors feed hourly clustering; candidates are labeled clustered, never identified.
- Vesting states come from contract records; jailing can extend windows and tombstoning forfeits unvested amounts - caveat is displayed.
- Solana bridged supply shows unreachable when the public RPC rate-limits this host.
- Native RBNT top holders are ranked among known addresses only; no complete richlist source exists yet.
- WRBNT-vs-native reconciliation gap (2.96B claimed vs bucket balances) is displayed as an open item; on-chain numbers are ground truth.

## CEX anchors (manual step)

Send a small RBNT deposit from each exchange account to capture the hot-wallet address, then add it on the CEX page or:

    curl -X POST localhost:8600/api/admin/anchors -H 'Content-Type: application/json' \
      -d '{"exchange":"gate","address":"0x..."}'
