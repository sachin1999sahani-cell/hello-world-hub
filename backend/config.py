import os

RPC_URL = "https://governors.mainnet.redbelly.network"
CHAIN_ID = 151
ROUTESCAN_API = "https://api.routescan.io/v2/network/mainnet/evm/151/etherscan/api"
EXPLORER = "https://redbelly.routescan.io"

WRBNT = "0x6ed1F491e2d31536D6561f6bdB2AdC8F092a6076"
STAKING = "0x818c3c113Ce240Ac92508f52F3DdDA675E6b6B9A"
USDC_E = "0x8201c02d4AB2214471E8C3AD6475C8b0CD9F2D06"

SIGNUP_FACTORY = "0x9DB12D3bd7F68b5D5D795CE0164DE321c29C5B64"
RETENTION_FACTORY = "0x7dac58Bb04f7144E03C6d5717Eb3A177b393CF1b"
FACTORY_CREATION_TOPIC = {
    "signup": "0x62e1054907fe2d392ee2c75ed24c8653e155f742f01379021594b72d38ebfd32",
    "retention": "0x97fa2b841ddf69c127e57319eee802d11c90c58c870cc5df5820ddb9f48e9ac9",
}

# WRBNT Transfer topic
TOPIC_TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"

OPERATIONAL_WALLET = "0x415cAD8Fc89F75a63C5B830E06460EEcdE083C9F"

TREASURY_WALLETS = [
    ("TEAM (Locked)", "0xbCee2DEfb7cF136480e3619Cf93E8129059977aF", "333.9M RBNT - 10% - 12mo cliff + 24mo linear", "official"),
    ("Reserve", "0x7473fEAf836b5319D9190d8367991Dc6ef33C16d", "2.0B RBNT - 20% - no defined release", "official"),
    ("Ecosystem (Locked)", "0xC5c131572d232512973e79204B93C2c1D57c879D", "2.79B RBNT", "official"),
    ("Ecosystem (Unlocked) / operational", "0x415cAD8Fc89F75a63C5B830E06460EEcdE083C9F", "Funds node-operator bonuses and DAO ops; deploys both vesting factories", "official"),
    ("Governance DAO (Locked)", "0x9a83957d3399CBBCbEf2112797B4a5B8e58C63d4", "133.3M RBNT current", "official"),
    ("USYD/CSIRO (Locked)", "0xAC27381EF74457c1258d54a808C2461eEdc56270", "200.0M RBNT - 2% - untouched", "official"),
    ("Seed + Private Sale A/B/C (pooled)", "0xef816d556e01bc194ae302999930eacd6dc4e566", "Origin wallet - original funding 2,785,987,082 RBNT approx 27.9% - moved via internal txs through Gnosis Safe singleton, trail leads to operational wallet and multisig 0xE0c701c40166BBD8D5f5Ec33c123F0A03E902DF7 - exact 4-way split not resolved on-chain", "inferred"),
    ("Seed trail multisig (GnosisSafeProxy)", "0xE0c701c40166BBD8D5f5Ec33c123F0A03E902DF7", "End of inferred seed/private-sale trail", "inferred"),
]

BRIDGED_WRBNT = [
    ("ethereum", "0xb45fFB51984d626Ee758b336C61Cf20990c6bF13",
     ["https://eth.llamarpc.com", "https://ethereum-rpc.publicnode.com", "https://cloudflare-eth.com"]),
    ("base", "0x020940df9F5E77338a094D55b5B5914122a804A5",
     ["https://mainnet.base.org", "https://base-rpc.publicnode.com"]),
]

DEX_POOLS = []  # discovered at runtime via factory/pair probing; see jobs/dex.py

COINGECKO_IDS = ["redbelly-network-token"]

# Poll schedules in seconds
SCHEDULE = {
    "managers": 1800,        # 30 min: discover new vesting managers
    "recipients": 21600,     # 6 h: roster refresh per manager
    "claims": 300,           # 5 min: incremental tokentx scan
    "balances": 900,         # 15 min: WRBNT balance for tracked wallets
    "vesting": 1800,         # 30 min: per-recipient vesting state
    "treasury": 300,         # 5 min
    "pools": 120,            # 2 min: reserves + price
    "pools_discover": 1800,  # 30 min: counterparty probe for new pairs
    "sell_impact": 300,      # 5 min: large sell correlation
    "holders": 3600,         # 1 h: tokenholderlist snapshot
    "market": 600,           # 10 min: price + market cap
    "bridged": 3600,         # 1 h
    "cex_cluster": 3600,     # 1 h
}

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "rbnt.db")
