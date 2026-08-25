import sqlite3, json, time, os, threading

from config import DB_PATH

_local = threading.local()
_write_lock = threading.RLock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS managers (
  address TEXT PRIMARY KEY,
  factory TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('signup','retention')),
  created_block INTEGER,
  created_at INTEGER,
  recipients_cached INTEGER,
  last_roster_sync INTEGER,
  last_claims_scan_block INTEGER DEFAULT 0);

CREATE TABLE IF NOT EXISTS recipients (
  manager TEXT NOT NULL,
  wallet TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (manager, wallet));

CREATE TABLE IF NOT EXISTS claims (
  tx_hash TEXT NOT NULL,
  manager TEXT NOT NULL,
  wallet TEXT NOT NULL,
  value_raw TEXT NOT NULL,
  block INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (tx_hash, manager, wallet, value_raw));
CREATE INDEX IF NOT EXISTS idx_claims_wallet ON claims(wallet);
CREATE INDEX IF NOT EXISTS idx_claims_manager ON claims(manager, ts);

CREATE TABLE IF NOT EXISTS address_stats (
  wallet TEXT PRIMARY KEY,
  claimed_total_raw TEXT NOT NULL DEFAULT '0',
  claims_count INTEGER NOT NULL DEFAULT 0,
  first_claim_ts INTEGER,
  last_claim_ts INTEGER,
  balance_raw TEXT,
  balance_updated_at INTEGER,
  sell_signal_score REAL NOT NULL DEFAULT 0,
  last_sell_signal_ts INTEGER,
  is_contract INTEGER);

CREATE TABLE IF NOT EXISTS vestings (
  vesting_id TEXT NOT NULL,
  manager TEXT NOT NULL,
  wallet TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  start_ts INTEGER, end_ts INTEGER, timelock INTEGER,
  initial_unlock_raw TEXT, cliff_release_ts INTEGER, cliff_amount_raw TEXT,
  interval_secs INTEGER, linear_amount_raw TEXT, released_or_claimed_raw TEXT,
  revoked INTEGER,
  window_label TEXT,
  state TEXT CHECK(state IN ('claimed','holding','not_claimed') OR state IS NULL),
  updated_at INTEGER,
  PRIMARY KEY (manager, vesting_id));
CREATE INDEX IF NOT EXISTS idx_vestings_wallet ON vestings(wallet);

CREATE TABLE IF NOT EXISTS treasury (
  label TEXT NOT NULL, address TEXT NOT NULL,
  note TEXT, confidence TEXT NOT NULL DEFAULT 'official',
  rbnt_balance_raw TEXT, wrbnt_balance_raw TEXT,
  eth_native_raw TEXT, updated_at INTEGER,
  PRIMARY KEY (label, address));

CREATE TABLE IF NOT EXISTS pools (
  address TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  token_a TEXT, token_b TEXT,
  reserve_a_raw TEXT, reserve_b_raw TEXT,
  price REAL, decimals_a INTEGER DEFAULT 18, decimals_b INTEGER DEFAULT 6,
  symbol_a TEXT, symbol_b TEXT, source TEXT DEFAULT 'discovered',
  updated_at INTEGER);

CREATE TABLE IF NOT EXISTS large_sells (
  tx_hash TEXT NOT NULL,
  log_index INTEGER NOT NULL,
  pool TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'interval',
  seller TEXT,
  rbnt_sold_raw TEXT,
  usdc_received_raw TEXT,
  price_before REAL, price_after REAL,
  impact_bps REAL,
  ts INTEGER NOT NULL,
  PRIMARY KEY (tx_hash, log_index));

CREATE TABLE IF NOT EXISTS native_holders (
  wallet TEXT PRIMARY KEY,
  balance_raw TEXT NOT NULL,
  updated_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS cex_volume_share (
  exchange TEXT PRIMARY KEY,
  volume_usd REAL NOT NULL,
  updated_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS top_holders (
  rank INTEGER NOT NULL,
  wallet TEXT NOT NULL,
  balance_raw TEXT NOT NULL,
  venue TEXT NOT NULL DEFAULT 'native',
  confidence TEXT NOT NULL DEFAULT 'unconfirmed',
  cex_guess TEXT,
  snapshot_at INTEGER NOT NULL,
  PRIMARY KEY (rank, snapshot_at, venue));

CREATE TABLE IF NOT EXISTS market_snapshots (
  ts INTEGER PRIMARY KEY,
  price_usd REAL, circulating_supply REAL,
  market_cap REAL, source TEXT);

CREATE TABLE IF NOT EXISTS bridged_supply (
  chain TEXT PRIMARY KEY,
  address TEXT, supply_raw TEXT, reachable INTEGER DEFAULT 0,
  updated_at INTEGER);

CREATE TABLE IF NOT EXISTS cex_anchors (
  exchange TEXT NOT NULL,
  address TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual',
  confidence TEXT NOT NULL DEFAULT 'identified',
  added_at INTEGER,
  PRIMARY KEY (exchange, address));

CREATE TABLE IF NOT EXISTS cex_clusters (
  exchange TEXT NOT NULL,
  address TEXT NOT NULL,
  anchor TEXT NOT NULL,
  score REAL NOT NULL,
  inflow_sources INTEGER,
  evidence_json TEXT,
  updated_at INTEGER,
  PRIMARY KEY (exchange, address));

CREATE TABLE IF NOT EXISTS transfer_edges (
  frm TEXT NOT NULL, to_addr TEXT NOT NULL,
  tx_count INTEGER NOT NULL DEFAULT 0,
  volume_raw TEXT NOT NULL DEFAULT '0',
  PRIMARY KEY (frm, to_addr));
CREATE INDEX IF NOT EXISTS idx_edges_to ON transfer_edges(to_addr);

CREATE TABLE IF NOT EXISTS transfers_raw (
  block INTEGER NOT NULL, ts INTEGER NOT NULL,
  frm TEXT NOT NULL, to_addr TEXT NOT NULL, value_raw TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_transfers_to ON transfers_raw(to_addr, ts);
CREATE INDEX IF NOT EXISTS idx_transfers_frm ON transfers_raw(frm, ts);

CREATE TABLE IF NOT EXISTS job_runs (
  job TEXT NOT NULL, started_at INTEGER, finished_at INTEGER,
  ok INTEGER, detail TEXT,
  PRIMARY KEY (job, started_at));
"""


def connect():
    conn = getattr(_local, "conn", None)
    if conn is None:
        os.makedirs(os.path.dirname(os.path.abspath(DB_PATH)), exist_ok=True)
        conn = sqlite3.connect(DB_PATH, timeout=30, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=ON")
        _local.conn = conn
    return conn


def init_db():
    with _write_lock, connect() as c:
        c.executescript(SCHEMA)


def q(sql, params=()):
    return connect().execute(sql, params).fetchall()


def one(sql, params=()):
    r = connect().execute(sql, params).fetchone()
    return dict(r) if r else None


def ex(sql, params=()):
    with _write_lock, connect() as c:
        c.execute(sql, params)
        c.commit()


def exmany(sql, rows):
    with _write_lock, connect() as c:
        c.executemany(sql, rows)
        c.commit()


def meta_get(key, default=None):
    r = one("SELECT value FROM meta WHERE key=?", (key,))
    return r["value"] if r else default


def meta_set(key, value):
    ex("INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
       (key, str(value)))


def log_job(job, started, ok, detail=""):
    ex("INSERT OR REPLACE INTO job_runs(job,started_at,finished_at,ok,detail) VALUES(?,?,?,?,?)",
       (job, started, int(time.time()), 1 if ok else 0, detail[:500]))
