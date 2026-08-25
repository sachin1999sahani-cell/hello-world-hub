/* RBNT Analytics - hash-routed views over the poller API */
"use strict";

const $view = document.getElementById("view");
const REFRESH_MS = 30000;
let activeRoute = null;
let refreshTimer = null;

/* ---------- formatting ---------- */
const NF0 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const NF2 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

function fmtRaw(rawStr, decimals = 18) {
  const n = Number(BigInt(rawStr || "0")) / 10 ** decimals;
  if (Math.abs(n) >= 1000) return NF0.format(n);
  return NF2.format(n);
}

function fmtUsd(n) {
  if (n === null || n === undefined) return "-";
  const a = Math.abs(n);
  if (a === 0) return "$0";
  if (a >= 1) return "$" + NF2.format(n);
  // sub-cent values need real precision: 6 decimals, trimmed
  let s = n.toFixed(6);
  return "$" + s;
}

/* Global rule: never truncate an address. Always full 42 chars, linked. */
function addrLink(a) {
  if (!a) return "-";
  const lower = a.toLowerCase();
  return `<a class="addr" href="https://redbelly.routescan.io/address/${lower}" target="_blank" rel="noopener">${a}</a>`;
}

function fmtTs(ts) {
  if (!ts) return "-";
  return new Date(ts * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function ago(ts) {
  if (!ts) return "-";
  const s = Math.floor(Date.now() / 1000 - ts);
  if (s < 90) return s + "s ago";
  if (s < 5400) return Math.round(s / 60) + "m ago";
  if (s < 172800) return Math.round(s / 3600) + "h ago";
  return Math.round(s / 86400) + "d ago";
}

/* ---------- status dot pattern ---------- */
function status(cls, label) {
  return `<span class="status ${cls}"><i class="dot"></i><span class="lbl">${label}</span></span>`;
}
const stateStatus = s =>
  s === "claimed" ? status("ok", "claimed") :
  s === "holding" ? status("warn", "holding") : status("neutral", "not claimed");

const confStatus = c =>
  c === "identified" || c === "official" ? status("ok", c) :
  c === "clustered" || c === "inferred" ? status("warn", c) : status("neutral", c || "unconfirmed");

function sellSignal(r) {
  const recent = r.last_sell_signal_ts && (Date.now() / 1000 - r.last_sell_signal_ts < 7 * 86400);
  if (recent) return status("bad", "sell signal");
  if (Number(r.sell_signal_score || 0) > 0.5)
    return status("warn", "sold " + Math.round(100 * r.sell_signal_score) + "%");
  return status("ok", "holding");
}

/* ---------- pagination ---------- */
const pagerState = {};

function paginate(key, rows, perPage = 25) {
  const st = pagerState[key] || (pagerState[key] = { page: 1 });
  st.pages = Math.max(1, Math.ceil(rows.length / perPage));
  st.page = Math.min(st.page, st.pages);
  const slice = rows.slice((st.page - 1) * perPage, st.page * perPage);
  const controls = `<div class="pager">
    <button class="btn ghost pg-btn" data-pg-key="${key}" data-pg-delta="-9999" ${st.page <= 1 ? "disabled" : ""}>First</button>
    <button class="btn ghost pg-btn" data-pg-key="${key}" data-pg-delta="-1" ${st.page <= 1 ? "disabled" : ""}>Prev</button>
    <span class="mono small muted">page ${st.page} of ${st.pages} - ${rows.length} rows</span>
    <button class="btn ghost pg-btn" data-pg-key="${key}" data-pg-delta="1" ${st.page >= st.pages ? "disabled" : ""}>Next</button>
    <button class="btn ghost pg-btn" data-pg-key="${key}" data-pg-delta="9999" ${st.page >= st.pages ? "disabled" : ""}>Last</button>
  </div>`;
  return { slice, controls };
}

function bindPagers(rerender, scope) {
  (scope || document).querySelectorAll(".pg-btn").forEach(b => b.addEventListener("click", () => {
    const st = pagerState[b.dataset.pgKey];
    if (b.dataset.pgDelta === "-9999") st.page = 1;
    else if (b.dataset.pgDelta === "9999") st.page = st.pages;
    else st.page = Math.min(Math.max(1, st.page + Number(b.dataset.pgDelta)), st.pages);
    rerender();
  }));
}

/* ---------- nav indicator (slides between tabs) ---------- */
function moveIndicator(routeName) {
  const ind = document.getElementById("navIndicator");
  const nav = document.getElementById("nav");
  if (!ind || !nav) return;
  const link = nav.querySelector(`a[data-route="${routeName}"]`);
  if (!link) { ind.style.opacity = "0"; return; }
  const nr = nav.getBoundingClientRect();
  const lr = link.getBoundingClientRect();
  ind.style.width = lr.width + "px";
  ind.style.transform = `translate(${lr.left - nr.left}px, -50%)`;
  ind.style.opacity = "1";
}
window.addEventListener("resize", () => activeRoute && moveIndicator(activeRoute.split("/")[0]));

/* keep old content visible while loading, then fade+slide the swap in */
function animateIn() {
  $view.classList.remove("page-enter");
  void $view.offsetWidth; // restart animation
  $view.classList.add("page-enter");
}

/* ---------- reusable scoped table search ---------- */
function searchInput(id, placeholder = "Filter by wallet address", initial = "") {
  return `<div class="tsearch">
    <input id="${id}" type="text" value="${esc(initial)}" placeholder="${esc(placeholder)}" autocomplete="off" spellcheck="false" aria-label="${esc(placeholder)}">
    <button type="button" class="ts-clear" id="${id}-clear" aria-label="Clear filter" ${initial ? "" : "hidden"}>&times;</button>
  </div>`;
}

function wireSearch(inputId, onChange, initial = "") {
  const inp = document.getElementById(inputId);
  const btn = document.getElementById(inputId + "-clear");
  if (!inp) return;
  inp.value = initial;                 // survive auto-refresh re-renders
  btn.hidden = !initial;
  let t = null;
  inp.addEventListener("input", () => {
    btn.hidden = !inp.value;
    clearTimeout(t);
    t = setTimeout(() => {
      pagerState[inputId] && (pagerState[inputId].page = 1);
      onChange(inp.value.trim().toLowerCase());
    }, 200);
  });
  btn.addEventListener("click", () => {
    inp.value = "";
    btn.hidden = true;
    pagerState[inputId] && (pagerState[inputId].page = 1);
    onChange("");
    inp.focus();
  });
}

/* ---------- api ---------- */
/* same-origin by default; for a split deploy (frontend on Vercel, backend on a
   VPS) set window.API_BASE in index.html to the backend origin, e.g.
   https://rbnt-api.example.com */
async function api(path) {
  const base = (typeof window.API_BASE === "string" && window.API_BASE.replace(/\/$/, "")) || "";
  const r = await fetch(base + path);
  if (!r.ok) throw new Error(path + " -> HTTP " + r.status);
  return r.json();
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------- shared render bits ---------- */
function statCard(label, value, sub) {
  return `<div class="card stat"><div class="label">${esc(label)}</div>
    <div class="value num">${value}</div>${sub ? `<div class="sub">${sub}</div>` : ""}</div>`;
}
const empty = msg => `<div class="card"><p class="muted">${esc(msg)}</p></div>`;
const updatedBanner = (updatedAt, cadence) =>
  `<p class="refresh-note">updated ${ago(updatedAt)} - poller cadence ${esc(cadence)}</p>`;

/* ---------- Page 1a: signup bonus claimants ---------- */
function sellBucket(r) {
  const claimed = BigInt(r.claimed_total_raw || "0");
  if (claimed <= 0n) return ["holding", 0];
  const bal = BigInt(r.balance_raw || "0");
  const soldNum = claimed > bal ? claimed - bal : 0n;
  const frac = Number(soldNum) / Number(claimed);
  if (frac >= 0.99) return ["sold100", frac];
  if (frac >= 0.01) return ["partial", frac];
  return ["holding", frac];
}

/* ---------- leaderboard renderer with scoped search ---------- */
function renderLeaderboardTable(containerId, rows, pagerKey) {
  const host = document.getElementById(containerId);
  if (!host) return;
  const q = (window._tblFilters && window._tblFilters[pagerKey]) || "";
  const filtered = q ? rows.filter(r => r.wallet.toLowerCase().includes(q)) : rows;
  if (!filtered.length) {
    host.innerHTML = searchInput(pagerKey + "-search", "Filter by wallet address", q) +
      `<p class="muted small">No wallet found${q ? ` matching "${esc(q)}"` : ""}.</p>`;
    wireSearch(pagerKey + "-search", v => { window._tblFilters[pagerKey] = v; renderLeaderboardTable(containerId, rows, pagerKey); }, q);
    return;
  }
  const { slice, controls } = paginate(pagerKey, filtered, 25);
  let html = searchInput(pagerKey + "-search", "Filter by wallet address", q);
  html += `<div class="tablewrap"><table><thead><tr>
    <th>Wallet</th><th class="num">WRBNT balance</th><th class="num">Claimed total</th>
    <th class="num">Claims</th><th>Last claim</th><th>Sell signal</th></tr></thead><tbody>`;
  for (const r of slice) {
    html += `<tr><td>${addrLink(r.wallet)}</td>
      <td class="num">${fmtRaw(r.balance_raw)}</td>
      <td class="num">${fmtRaw(r.claimed_total_raw)}</td>
      <td class="num">${NF0.format(r.claims_count)}</td>
      <td class="num muted small">${fmtTs(r.last_claim_ts)}</td>
      <td>${sellSignal(r)}</td></tr>`;
  }
  html += `</tbody></table></div>${controls}`;
  host.innerHTML = html;
  wireSearch(pagerKey + "-search", v => {
    window._tblFilters[pagerKey] = v;
    renderLeaderboardTable(containerId, rows, pagerKey);
  }, q);
  bindPagers(() => renderLeaderboardTable(containerId, rows, pagerKey));
}

async function renderOperators() {
  const scope = window._opsScope || "primary";
  const [d, dAll, ret] = await Promise.all([
    api("/api/node-operators?scope=" + scope),
    api("/api/node-operators?scope=all"),
    api("/api/retention"),
  ]);
  let html = `<div class="section-head">
    <h1 style="margin:0">Node operators</h1>
    <button class="btn ghost" id="scopeToggle">${scope === "primary" ? "All managers" : "Verified manager only"}</button>
  </div>`;
  html += `<p class="muted small">${esc(d.scope_note)}</p>`;

  html += `<section class="grid cols-4">
    ${statCard("Unique claiming addresses", NF0.format(d.unique_claimers))}
    ${statCard("Roster size", NF0.format(d.roster_size))}
    ${statCard("Total WRBNT claimed", fmtRaw(d.total_claimed_raw))}
    ${statCard("Claim transactions", NF0.format(d.claim_txs))}
  </section>`;
  html += updatedBanner(d.updated_at, "roster 6h - claims 5 min - balances 15 min");

  /* diagrams: roster donut + sell/hold donuts (current scope and all-managers) */
  html += `<section class="grid cols-3">
    <div class="card"><h3>Roster status - claimed vs never claimed</h3><div id="donutRoster"></div></div>
    <div class="card"><h3>Sell vs hold - ${scope === "primary" ? "verified manager" : "all managers"}</h3><div id="donutSell"></div></div>
    <div class="card"><h3>Sell vs hold - all managers</h3><div id="donutSellAll"></div></div>
  </section>`;

  /* leaderboard */
  html += `<h2>Leaderboard - current WRBNT balance</h2>`;
  if (!d.leaderboard.length) {
    html += empty("Balances not polled yet. First pass takes several minutes.");
  } else {
    html += `<div id="opsLbHost"></div>`;
    html += `<p class="muted small">Sell signal combines two checks: balance drop within 7 days of a claim, and outbound WRBNT transfers to addresses outside known contracts. Sold percent is a lower bound - external inflows are not attributed.</p>`;
  }

  /* never claimed */
  html += `<h2>Signed up but never claimed</h2>`;
  const nc = d.never_claimed_by_manager[0];
  if (!nc) {
    html += empty("No manager roster synced yet.");
  } else if (nc.wallets && nc.wallets.length) {
    const { slice, controls } = paginate("opsNc", nc.wallets, 25);
    html += `<div class="tablewrap"><table><thead><tr><th>Wallet</th><th>Status</th></tr></thead><tbody>`;
    for (const w of slice) {
      html += `<tr><td>${addrLink(w)}</td><td>${status("neutral", "never claimed")}</td></tr>`;
    }
    html += `</tbody></table></div>${controls}`;
  } else if (nc.count !== undefined) {
    html += `<div class="tablewrap"><table><thead><tr><th>Manager</th><th class="num">Never claimed</th></tr></thead><tbody>`;
    for (const m of d.never_claimed_by_manager) {
      html += `<tr><td>${addrLink(m.manager)}</td><td class="num">${NF0.format(m.count)}</td></tr>`;
    }
    html += `</tbody></table></div>`;
  }

  /* retention */
  html += `<h2>Retention bonus - 50K windows</h2>`;
  html += `<div class="banner">Vesting state comes from each manager contract record, not from start and end dates alone. Jailing can extend vesting and tombstoning ends it and forfeits the unvested balance.</div>`;
  for (const m of ret.managers) {
    html += `<div class="card" style="margin-bottom:16px">
      <div class="section-head">
        <h3 style="margin:0">Manager</h3>
        ${addrLink(m.manager)}
        <span class="tag">${NF0.format(m.recipients_cached || 0)} recipients</span>
      </div>`;
    for (const w of m.windows) {
      const tot = Math.max(1, w.total);
      html += `<div style="margin-top:12px">
        <div class="section-head">
          <strong class="mono">${esc(w.part)}</strong>
          ${status("ok", w.claimed + " claimed")}
          ${status("warn", w.holding + " holding")}
          ${status("neutral", w.not_claimed + " not claimed")}
          <span class="muted small">${w.total} records</span>
        </div>
        <div class="bar" style="margin-top:8px">
          <i class="ok" style="width:${100 * w.claimed / tot}%"></i>
          <i class="hold" style="width:${100 * w.holding / tot}%"></i>
          <i class="none" style="width:${100 * w.not_claimed / tot}%"></i>
        </div></div>`;
    }
    if (!m.windows.length) html += `<p class="muted small">Vesting records not decoded yet.</p>`;
    html += `<div id="retRec-${m.manager.slice(0, 10)}"></div></div>`;
    loadRetentionRecipients(m.manager);
  }

  $view.innerHTML = html;
  window._tblFilters = window._tblFilters || {};
  renderLeaderboardTable("opsLbHost", d.leaderboard, "opsLb");

  /* charts via shared module */
  setChart("donutRoster", renderBars({
    data: [{ label: "Roster", values: {
      claimed: d.unique_claimers,
      never: Math.max(0, d.roster_size - d.unique_claimers) } }],
    series: [{ key: "claimed", label: "Claimed at least once", color: "#86EFAC" },
             { key: "never", label: "Never claimed", color: "#93a4ae" }],
    height: 240 }));

  const sellSeries = rows => {
    const c = { holding: 0, partial: 0, sold100: 0 };
    rows.forEach(r => c[sellBucket(r)[0]]++);
    return { data: [{ label: "Claimants", values: c }],
      series: [{ key: "holding", label: "Still holding", color: "#86EFAC" },
               { key: "partial", label: "Sold part", color: "#FCD34D" },
               { key: "sold100", label: "Sold essentially all", color: "#EF5350" }],
      height: 240 };
  };
  setChart("donutSell", renderBars(sellSeries(d.leaderboard)));
  if (dAll) setChart("donutSellAll", renderBars(sellSeries(dAll.leaderboard || [])));

  bindPagers(() => route(activeRoute, true));
  document.getElementById("scopeToggle")?.addEventListener("click", () => {
    window._opsScope = scope === "primary" ? "all" : "primary";
    route(activeRoute, true);
  });
}

async function loadRetentionRecipients(manager) {
  try {
    // pull the entire record set for this manager, then filter + paginate client-side
    let page = 1, items = [], meta = null;
    while (true) {
      const d = await api(`/api/retention/recipients?manager=${manager}&page=${page}&per_page=100`);
      meta = d;
      items = items.concat(d.items);
      if (page >= d.pages || !d.items.length) break;
      page++;
    }
    renderRecipientTable(manager, items);
  } catch (e) { /* leave section empty */ }
}

function renderRecipientTable(manager, allItems) {
  const host = document.getElementById(`retRec-${manager.slice(0, 10)}`);
  if (!host) return;
  const key = "ret-" + manager.slice(0, 10);
  const q = (window._tblFilters && window._tblFilters[key]) || "";
  const filtered = q ? allItems.filter(it => it.wallet.toLowerCase().includes(q)) : allItems;
  window._retOpen = window._retOpen || {};
  const isOpen = window._retOpen[manager] !== false; // default open
  let html = `<details ${isOpen ? "open" : ""} data-mgr="${esc(manager)}"><summary class="accent-link" style="cursor:pointer">Per-recipient states (${NF0.format(filtered.length)}${q ? " matching" : " total"})</summary>`;
  html += searchInput(key + "-search", "Filter by wallet address", q);
  if (!filtered.length) {
    html += `<p class="muted small">No wallet found${q ? ` matching "${esc(q)}"` : ""}.</p></details>`;
    host.innerHTML = html;
    wireSearch(key + "-search", v => { window._tblFilters[key] = v; renderRecipientTable(manager, allItems); }, q);
    return;
  }
  const { slice, controls } = paginate(key, filtered, 25);
  html += `<div class="tablewrap" style="margin-top:12px"><table><thead><tr>
    <th>Wallet</th>${slice[0] ? slice[0].windows.map(w => `<th>${esc(w.part || "")}</th>`).join("") : ""}
  </tr></thead><tbody>`;
  for (const it of slice) {
    html += `<tr><td>${addrLink(it.wallet)}</td>`;
    for (const w of it.windows) {
      html += `<td>${stateStatus(w.state)}<br><span class="mono small muted">${fmtRaw(w.claimed_raw)} / ${fmtRaw(w.alloc_raw)}</span></td>`;
    }
    html += `</tr>`;
  }
  html += `</tbody></table></div>${controls}`;
  html += `<p class="muted small">All ${NF0.format(allItems.length)} records reachable. Poller refreshes states every 30 minutes.</p></details>`;
  host.innerHTML = html;
  const det = host.querySelector("details");
  det.addEventListener("toggle", () => { window._retOpen[manager] = det.open; });
  wireSearch(key + "-search", v => { window._tblFilters[key] = v; renderRecipientTable(manager, allItems); }, q);
  bindPagers(() => renderRecipientTable(manager, allItems));
}

/* ---------- Page 2: treasury ---------- */
async function renderTreasury() {
  const d = await api("/api/treasury");
  let html = `<h1>Treasury and team wallets</h1>`;
  if (!d.wallets.length) { $view.innerHTML = html + empty("Treasury balances not polled yet."); return; }
  html += `<div class="tablewrap"><table><thead><tr>
    <th>Wallet</th><th>Address</th><th class="num">RBNT native</th><th class="num">WRBNT wrapped</th><th>Note</th><th>Source</th><th>Updated</th>
  </tr></thead><tbody>`;
  for (const w of d.wallets) {
    html += `<tr>
      <td><strong>${esc(w.label)}</strong></td>
      <td>${addrLink(w.address)}</td>
      <td class="num">${fmtRaw(w.eth_native_raw)}</td>
      <td class="num">${fmtRaw(w.rbnt_balance_raw)}</td>
      <td class="small muted" style="white-space:normal;min-width:280px;max-width:480px">${esc(w.note || "")}</td>
      <td>${w.confidence === "official" ? status("ok", "official") : status("warn", "inferred")}</td>
      <td class="num muted small">${ago(w.updated_at)}</td></tr>`;
  }
  html += `</tbody></table></div>`;
  html += `<div id="donutTreasury"></div>`;
  html += `<div id="donutTeam"></div>`;
  html += `<div class="banner info">Seed plus Private Sale A/B/C is pooled at the wallet level. The exact 4-way split has no on-chain record, so no breakdown is shown. That trail is inferred from funding pattern and amount match, not an official tag.</div>`;
  $view.innerHTML = html;

  /* composition chart: live native balances grouped into spec buckets */
  const w = d.wallets;
  const bal = label => (w.find(x => x.label.startsWith(label))?.eth_native_raw) || "0";
  const eco = (BigInt(bal("Ecosystem (Locked)")) + BigInt(bal("Ecosystem (Unlocked"))).toString();
  const seed = (BigInt(bal("Seed + Private Sale")) + BigInt(bal("Seed trail"))).toString();
  const toM = v => Number(BigInt(v) / 10n ** 12n) / 1e6;
  setChart("donutTreasury", renderBars({
    horizontal: true, height: 260,
    data: [
      { label: "Reserve", values: { rbnt: toM(bal("Reserve")) } },
      { label: "Ecosystem", values: { rbnt: toM(eco) } },
      { label: "TEAM", values: { rbnt: toM(bal("TEAM")) } },
      { label: "Governance", values: { rbnt: toM(bal("Governance DAO")) } },
      { label: "USYD/CSIRO", values: { rbnt: toM(bal("USYD/CSIRO")) } },
      { label: "Seed pooled", values: { rbnt: toM(seed) } },
    ],
    series: [{ key: "rbnt", label: "RBNT native (millions)", color: "#EF5350" }],
  }));

  /* team claimed-vs-locked: original 1B vs current balance */
  {
    const teamCur = BigInt(bal("TEAM"));
    const teamOrig = 1000000000n * 10n ** 18n;
    const distributed = teamOrig > teamCur ? teamOrig - teamCur : 0n;
    setChart("donutTeam", renderBars({
      data: [{ label: "Team 1B allocation", values: {
        distributed: Number(distributed / 10n ** 12n) / 1e6,
        locked: Number(teamCur / 10n ** 12n) / 1e6 } }],
      series: [{ key: "distributed", label: "Distributed to team members", color: "#FCD34D" },
               { key: "locked", label: "Still locked in wallet", color: "#86EFAC" }],
      height: 220 }));
  }
}

/* ---------- price impact math (constant product, no fees) ---------- */
function impactRows(R) {
  // sell to drop price to ratio x current: amountOut = R*(1/sqrt(ratio)-1)
  // buy to raise price to ratio x current: amountIn = R*(1-sqrt(1/ratio)) -> R*(1-1/sqrt(ratio))
  const rows = [];
  for (let pct = -90; pct <= 200; pct += 10) {
    const ratio = 1 + pct / 100;
    const amt = ratio < 1
      ? R * (1 / Math.sqrt(ratio) - 1)   // RBNT sold into pool
      : R * (1 - 1 / Math.sqrt(ratio));  // RBNT bought out of pool
    rows.push({ pct, ratio, amount: amt });
  }
  return rows;
}

function impactChart(R, sym, currentPrice) {
  const W = 720, H = 300, padL = 70, padR = 20, padT = 16, padB = 40;
  const maxSell = R * (1 / Math.sqrt(0.1) - 1);
  const maxBuy = R * (1 - 1 / Math.sqrt(3));
  const pts = [];
  for (let i = 0; i <= 120; i++) {
    const a = (maxSell + maxBuy) * (-0.5 + i / 120); // negative = sold in
    const newReserve = Math.max(1e-9, R + a);
    const pNew = (R * R) / newReserve;
    pts.push({ traded: -a, pct: (pNew - 1) * 100 });
  }
  const xMax = maxSell, yMin = -95, yMax = 205;
  const xPos = v => padL + (v / xMax) * ((W - padL - padR) / 2);
  const yPos = v => padT + (yMax - v) / (yMax - yMin) * (H - padT - padB);

  let path = "";
  pts.forEach((p, i) => {
    path += (i === 0 ? "M" : "L") + xPos(p.traded).toFixed(1) + " " + yPos(p.pct).toFixed(1);
  });

  // markers every 8th point plus the zero point: circles with exact-value tooltips
  let markers = "";
  pts.forEach((p, i) => {
    if (i % 8 !== 0 && i !== 60) return;
    markers += `<circle class="chart-pt" cx="${xPos(p.traded).toFixed(1)}" cy="${yPos(p.pct).toFixed(1)}"
      data-traded="${NF0.format(Math.abs(p.traded))}" data-dir="${p.traded >= 0 ? "sold" : "bought"}"
      data-pct="${p.pct > 0 ? "+" : ""}${p.pct.toFixed(1)}" data-price="${currentPrice !== undefined && currentPrice !== null ? fmtUsd(currentPrice * (1 + p.pct / 100)) : "-"}"><title></title></circle>`;
  });

  const gridY = [];
  for (let g = -90; g <= 200; g += 50) {
    gridY.push(`<line x1="${padL}" y1="${yPos(g)}" x2="${W - padR}" y2="${yPos(g)}" stroke="var(--grid-line)" stroke-width="1"/>
      <text x="${padL - 6}" y="${yPos(g) + 4}" fill="var(--muted)" font-size="11" text-anchor="end" font-family="JetBrains Mono">${g}%</text>`);
  }
  const gridX = [];
  for (let f = 0; f <= 1.01; f += 0.25) {
    const xv = maxSell * f;
    gridX.push(`<text x="${xPos(xv)}" y="${H - padB + 18}" fill="var(--muted)" font-size="11" text-anchor="middle" font-family="JetBrains Mono">${NF0.format(xv)}</text>`);
  }
  return `<div class="chart-wrap"><svg class="chart-svg" viewBox="0 0 ${W} ${H}">
    ${gridY.join("")}${gridX.join("")}
    <line x1="${padL}" y1="${yPos(0)}" x2="${W - padR}" y2="${yPos(0)}" stroke="var(--outline-variant)" stroke-width="1" stroke-dasharray="4 4"/>
    <path d="${path}" fill="none" stroke="#EF5350" stroke-width="2"/>
    ${markers}
    <text x="${W - padR}" y="${padT + 12}" fill="var(--text-secondary)" font-size="12" text-anchor="end" font-family="Be Vietnam Pro">price change vs ${sym} sold (right of 0 is buys)</text>
    <text x="${(W + padL) / 2}" y="${H - 6}" fill="var(--muted)" font-size="12" text-anchor="middle" font-family="JetBrains Mono">${sym} traded</text>
  </svg><p class="refresh-note muted small">Hover the red points for exact values.</p></div>`;
}

/* ---------- unified chart module (single system for every chart) ---------- */
function setChart(id, html) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = html;
}
const CHART_PALETTE = ["#EF5350", "#93a4ae", "#FCD34D", "#b8c4cc", "#66757f", "#86EFAC"];

function axisFmt(v) { return formatCompact(v); }

function legendHTML(series) {
  return `<div class="chart-legend">${series.map(s =>
    `<span><i style="background:${s.color}"></i>${esc(s.label)}</span>`).join("")}</div>`;
}

/* Grouped/stacked bars, vertical or horizontal. Staggered grow-in, shared tooltip. */
function renderBars(o) {
  const series = o.series, data = o.data;
  const horizontal = !!o.horizontal;
  const W = 760, H = o.height || 300;
  const padL = 56, padR = 14, padT = 16, padB = 40;
  const max = o.max || Math.max(1, ...data.map(d => Math.max(...series.map(s => d.values[s.key] || 0))));
  const plotW = (horizontal ? W - padL - padR : W - padL - padR);
  const plotH = H - padT - padB;
  const slot = (horizontal ? plotH : plotW) / Math.max(1, data.length);
  const groupW = Math.min(horizontal ? 30 : 44, slot * .68);
  const barW = series.length > 1 ? groupW / series.length : groupW * .8;
  let grid = "", rects = "", hits = "", labels = "";
  // grid + ticks
  for (let g = 0; g <= 4; g++) {
    const v = max / 4 * g;
    if (horizontal) {
      const x = padL + plotW / 4 * g;
      grid += `<line x1="${x}" y1="${padT}" x2="${x}" y2="${H - padB}" stroke="var(--grid-line)" stroke-width="1"/>
        <text x="${x}" y="${H - padB + 16}" fill="var(--muted)" font-size="10.5" text-anchor="middle" font-family="JetBrains Mono">${axisFmt(v)}</text>`;
    } else {
      const y = padT + plotH - plotH / 4 * g;
      grid += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="var(--grid-line)" stroke-width="1"/>
        <text x="${padL - 6}" y="${y + 4}" fill="var(--muted)" font-size="10.5" text-anchor="end" font-family="JetBrains Mono">${axisFmt(v)}</text>`;
    }
  }
  data.forEach((d, i) => {
    let acc = 0;
    const base = (horizontal ? padT : padL) + i * slot + (slot - (o.stacked ? barW : groupW)) / 2;
    series.forEach((s, j) => {
      const v = d.values[s.key] || 0;
      const color = s.color || CHART_PALETTE[j % CHART_PALETTE.length];
      const delay = i * 32 + j * 48;
      if (o.stacked && !horizontal) {
        const h = v / max * plotH;
        const y = padT + plotH - acc / max * plotH - h;
        rects += `<rect class="bar-rect gy" style="animation-delay:${delay}ms" x="${base.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(h, v > 0 ? 1 : 0).toFixed(1)}" fill="${color}"/>`;
        acc += v;
      } else if (horizontal) {
        const w = v / max * plotW;
        const y = base + j * (series.length > 1 ? barW : 0);
        rects += `<rect class="bar-rect gx" style="animation-delay:${delay}ms" x="${padL}" y="${y.toFixed(1)}" width="${Math.max(w, v > 0 ? 1 : 0).toFixed(1)}" height="${barW.toFixed(1)}" fill="${color}"/>`;
      } else {
        const h = v / max * plotH;
        const x = base + j * barW;
        rects += `<rect class="bar-rect gy" style="animation-delay:${delay}ms" x="${x.toFixed(1)}" y="${(H - padB - h).toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(h, v > 0 ? 1 : 0).toFixed(1)}" fill="${color}"/>`;
      }
    });
    // label
    if (horizontal) {
      labels += `<text x="${padL - 6}" y="${(base + barW / 2 + 4).toFixed(1)}" fill="var(--muted)" font-size="11" text-anchor="end" font-family="JetBrains Mono">${esc(String(d.label).slice(0, 12))}</text>`;
    } else {
      labels += `<text x="${(base + (series.length > 1 ? groupW : barW) / 2).toFixed(1)}" y="${H - padB + 16}" fill="var(--muted)" font-size="10.5" text-anchor="middle" font-family="JetBrains Mono">${esc(String(d.label).slice(0, 10))}</text>`;
    }
    // hit area with exact values
    const tipLines = series.map((s, j) => {
      const v = d.values[s.key] || 0;
      return `<span style="color:${s.color || CHART_PALETTE[j % CHART_PALETTE.length]}">&#9679;</span> ${esc(s.label)}: <b>${NF0.format(v)}</b>`;
    }).join("<br>");
    if (horizontal) {
      hits += `<rect class="vbar-hit" x="${padL}" y="${(base - 2).toFixed(1)}" width="${plotW}" height="${slot.toFixed(1)}" data-tip="<b>${esc(d.label)}</b><br>${tipLines}"></rect>`;
    } else {
      hits += `<rect class="vbar-hit" x="${(padL + i * slot).toFixed(1)}" y="${padT}" width="${slot.toFixed(1)}" height="${plotH}" data-tip="<b>${esc(d.label)}</b><br>${tipLines}"></rect>`;
    }
  });
  const svg = `<svg class="chart-svg" viewBox="0 0 ${W} ${H}">${grid}${rects}${hits}${labels}</svg>`;
  return `<div class="chart-wrap">${svg}${legendHTML(series)}</div>`;
}

/* Two-series impact line: sell path down, buy path up, current-price reference */
function renderImpactLine(R, sym, currentPrice) {
  if (!isFinite(R) || R <= 0) {
    return `<p class="muted small">Reserves not readable right now - chart returns on the next reserve poll.</p>`;
  }
  const W = 760, H = 320, padL = 70, padR = 20, padT = 16, padB = 40;
  const maxSell = R * (1 / Math.sqrt(.1) - 1);
  const steps = [];
  for (let p = -90; p <= 200; p += 10) steps.push(p);
  const yPos = pct => padT + (205 - pct) / 295 * (H - padT - padB);
  const xPosUnused = null;
  // build sell path (-90 -> 0) and buy path (0 -> +200), x by cumulative trade size
  const sellPts = [], buyPts = [];
  steps.forEach(p => {
    const ratio = (100 + p) / 100;
    const amt = ratio < 1 ? R * (1 / Math.sqrt(ratio) - 1) : R * (1 - 1 / Math.sqrt(ratio));
    (p <= 0 ? sellPts : buyPts).push({ pct: p, amt });
  });
  const xSell = amt => padL + (amt / maxSell) * ((W - padL - padR) / 2);
  const xBuy = amt => padL + (W - padL - padR) / 2 + (amt / Math.max(maxSell, R * (1 - 1 / Math.sqrt(3)))) * ((W - padL - padR) / 2);
  let paths = "", markers = "";
  let dSell = "";
  sellPts.forEach((p, i) => {
    dSell += (i ? "L" : "M") + xSell(p.amt).toFixed(1) + " " + yPos(p.pct).toFixed(1);
    markers += `<circle class="chart-pt" cx="${xSell(p.amt).toFixed(1)}" cy="${yPos(p.pct).toFixed(1)}" r="3.5"
      data-traded="${NF0.format(p.amt)}" data-dir="sold into pool" data-pct="${p.pct}%"
      data-price="${currentPrice != null ? fmtUsd(currentPrice * (1 + p.pct / 100)) : "-"}"><title></title></circle>`;
  });
  let dBuy = "";
  buyPts.forEach((p, i) => {
    dBuy += (i ? "L" : "M") + xBuy(p.amt).toFixed(1) + " " + yPos(p.pct).toFixed(1);
    markers += `<circle class="chart-pt" cx="${xBuy(p.amt).toFixed(1)}" cy="${yPos(p.pct).toFixed(1)}" r="3.5"
      data-traded="${NF0.format(p.amt)}" data-dir="bought from pool" data-pct="+${p.pct}%"
      data-price="${currentPrice != null ? fmtUsd(currentPrice * (1 + p.pct / 100)) : "-"}"><title></title></circle>`;
  });
  paths = `<path d="${dSell}" fill="none" stroke="#FCD34D" stroke-width="2"/>
           <path d="${dBuy}" fill="none" stroke="#86EFAC" stroke-width="2"/>`;
  const refY = yPos(0);
  const refLine = currentPrice != null
    ? `<line x1="${padL}" y1="${refY}" x2="${W - padR}" y2="${refY}" stroke="var(--outline-variant)" stroke-dasharray="4 4" stroke-width="1"/>
       <text x="${W - padR}" y="${refY - 6}" fill="var(--muted)" font-size="10.5" text-anchor="end" font-family="JetBrains Mono">current ${fmtUsd(currentPrice)}</text>` : "";
  const gridY = [];
  [-75, -50, -25, 25, 50, 75, 125, 175].forEach(g => {
    gridY.push(`<line x1="${padL}" y1="${yPos(g)}" x2="${W - padR}" y2="${yPos(g)}" stroke="var(--grid-line)" stroke-width="1"/>
      <text x="${padL - 6}" y="${yPos(g) + 4}" fill="var(--muted)" font-size="10.5" text-anchor="end" font-family="JetBrains Mono">${g}%</text>`);
  });
  const legend = legendHTML([
    { key: "sell", label: "sell path", color: "#FCD34D" },
    { key: "buy", label: "buy path", color: "#86EFAC" },
  ]);
  return `<div class="chart-wrap"><svg class="chart-svg" viewBox="0 0 ${W} ${H}">
    ${gridY.join("")}${refLine}${paths}${markers}
    <text x="${(W + padL) / 2}" y="${H - 8}" fill="var(--muted)" font-size="11" text-anchor="middle" font-family="JetBrains Mono">${sym} traded (hover points for exact numbers)</text>
  </svg>${legend}</div>`;
}

/* ---------- diagram primitives ---------- */
const SEG_COLORS = ["#EF5350", "#86EFAC", "#FCD34D", "#93a4ae", "#b8c4cc", "#66757f", "#3a4650"];

/* 5893783974.36 -> "5.89B" - keeps donut centers inside the ring at any magnitude */
function formatCompact(v) {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 2 }).format(v);
}

function polar(cx, cy, r, deg) {
  const rad = (deg - 90) * Math.PI / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

/* Vertical diverging bar chart: sells extend down (warn), buys up (ok) */
function impactBars(R, sym, currentPrice) {
  if (!isFinite(R) || R <= 0) {
    return `<p class="muted small">Reserves not readable right now - chart returns on the next reserve poll.</p>`;
  }
  const W = 760, H = 340, padL = 64, padR = 16, padT = 18, padB = 46;
  const steps = [];
  for (let pct = -90; pct <= 200; pct += 10) steps.push(pct);
  const yMaxUp = H * 0.62, yMaxDown = H * 0.30; // px budget per side
  const yZero = padT + yMaxUp;
  const bw = (W - padL - padR) / steps.length;
  const yPos = pct => pct >= 0 ? yZero - (pct / 200) * (yMaxUp - 6) : yZero - (pct / 90) * (yMaxDown - 4);
  let bars = "", hits = "", labels = "";
  steps.forEach((pct, i) => {
    const x = padL + i * bw;
    const y = yPos(pct);
    const h = Math.abs(y - yZero);
    const color = pct < 0 ? "#FCD34D" : pct > 0 ? "#86EFAC" : "#93a4ae";
    const targetPrice = currentPrice != null ? fmtUsd(currentPrice * (1 + pct / 100)) : "-";
    const ratio = 1 + pct / 100;
    const amt = ratio < 1 ? R * (1 / Math.sqrt(ratio) - 1) : R * (1 - 1 / Math.sqrt(ratio));
    const tip = `${pct > 0 ? "+" : ""}${pct}% - price ${targetPrice}<br>${pct < 0 ? "sell" : pct > 0 ? "buy" : "-"} ${NF0.format(amt)} ${sym}`;
    bars += `<rect x="${(x + 2).toFixed(1)}" y="${Math.min(y, yZero).toFixed(1)}" width="${Math.max(1, bw - 4).toFixed(1)}"
      height="${Math.max(h, 1).toFixed(1)}" fill="${color}" opacity="0.9"/>`;
    // circular marker at bar end + transparent hit area covering the column
    bars += `<circle class="chart-pt" cx="${(x + bw / 2).toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="#EF5350" stroke="var(--card)" stroke-width="1.5"
      data-traded="${NF0.format(amt)}" data-dir="${pct < 0 ? "sold into pool" : pct > 0 ? "bought from pool" : "no trade"}"
      data-pct="${pct > 0 ? "+" : ""}${pct}%" data-price="${targetPrice}"></circle>`;
    hits += `<rect class="vbar-hit" x="${x.toFixed(1)}" y="${padT}" width="${bw.toFixed(1)}" height="${H - padT - padB}"
      data-tip="${tip}"></rect>`;
    if (pct % 50 === 0 || pct === -90 || pct === 200) {
      labels += `<text x="${(x + bw / 2).toFixed(1)}" y="${H - padB + 16}" fill="var(--muted)" font-size="10.5" text-anchor="middle" font-family="JetBrains Mono">${pct > 0 ? "+" : ""}${pct}%</text>`;
    }
  });
  const gridY = [];
  [-75, -50, -25, 25, 50, 75].forEach(p => {
    gridY.push(`<line x1="${padL}" y1="${yPos(p)}" x2="${W - padR}" y2="${yPos(p)}" stroke="var(--grid-line)" stroke-width="1"/>
      <text x="${padL - 6}" y="${yPos(p) + 4}" fill="var(--muted)" font-size="11" text-anchor="end" font-family="JetBrains Mono">${p}%</text>`);
  });
  return `<div class="chart-wrap"><svg class="chart-svg" viewBox="0 0 ${W} ${H}">
    ${gridY.join("")}
    <line x1="${padL}" y1="${yZero}" x2="${W - padR}" y2="${yZero}" stroke="var(--outline-variant)" stroke-width="1.5"/>
    ${bars}${hits}${labels}
    <text x="${padL}" y="${padT - 4}" fill="var(--muted)" font-size="11" font-family="JetBrains Mono">buys raise price</text>
    <text x="${padL}" y="${H - padB + 34}" fill="var(--muted)" font-size="11" font-family="JetBrains Mono">sells lower it - one bar per threshold step</text>
  </svg><p class="refresh-note muted small">Hover any bar or red point for its exact numbers.</p></div>`;
}

/* one delegated tooltip for every chart/donut on the site */
document.addEventListener("mouseover", e => {
  const el = e.target.closest(".chart-pt,.donut-seg,.vbar-hit");
  const tip = document.getElementById("chartTip");
  if (!el || !tip) return;
  if (el.classList.contains("chart-pt")) {
    tip.innerHTML = `${esc(el.dataset.dir)}: ${el.dataset.traded}<br>price change: ${el.dataset.pct}<br>resulting price: ${el.dataset.price}`;
  } else {
    tip.innerHTML = el.dataset.tip || "";
  }
  tip.hidden = false;
});
document.addEventListener("mousemove", e => {
  const tip = document.getElementById("chartTip");
  if (!tip || tip.hidden) return;
  tip.style.left = Math.min(e.clientX + 14, window.innerWidth - 240) + "px";
  tip.style.top = (e.clientY + 14) + "px";
});
document.addEventListener("mouseout", e => {
  if (!e.target.closest || !e.target.closest(".chart-pt,.donut-seg,.vbar-hit")) return;
  const tip = document.getElementById("chartTip");
  if (tip) tip.hidden = true;
});

/* ---------- Page 3: DEX ---------- */
async function renderDex() {
  const d = await api("/api/dex");
  let html = `<h1>DEX - Reddex</h1>`;
  html += `<p class="muted small">All pools resolved from the Reddex factory contract and verified for getReserves before display.</p>`;

  if (!d.pools.length) {
    $view.innerHTML = html + empty("No pool contracts confirmed yet.");
    return;
  }
  html += `<div class="grid cols-2">`;
  for (const p of d.pools) {
    const stableSide = p.price ? fmtUsd(p.price) : "no stable leg";
    html += `<div class="card raised">
      <h3 style="margin-top:0" class="mono">${esc(p.label)}</h3>
      <div class="stat"><div class="label">Price of volatile leg</div><div class="value num">${stableSide}</div></div>
      <p class="small muted mono">${addrLink(p.address)}</p>
      <p class="small muted">reserves: ${fmtRaw(p.reserve_a_raw, p.decimals_a ?? 18)} ${esc(p.symbol_a ?? "?")} / ${fmtRaw(p.reserve_b_raw, p.decimals_b ?? 18)} ${esc(p.symbol_b ?? "?")}</p>
      <p class="refresh-note">reserves ${ago(p.updated_at)}${p.source ? " - source " + esc(p.source) : ""}</p>
    </div>`;
  }
  html += `</div>`;
  html += `<p class="muted small">On-chain pool prices update every 2 minutes. This catches dumps faster than CEX aggregators that lag.</p>`;

  /* impact threshold: selector over stable-priced pools, default first */
  const priced = d.pools.filter(p => p.price);
  const sel = window._impactPool && priced.some(x => x.address === window._impactPool)
    ? window._impactPool : (priced[0] && priced[0].address);
  if (sel) {
    const p = priced.find(x => x.address === sel);
    // pick volatile side = non-stable token; R = its reserve in whole tokens
    let volSym, Ruse;
    if ((p.symbol_b === "USDC.e" || p.symbol_b === "USDT")) {
      volSym = p.symbol_a || "?";
      Ruse = parseFloat(BigInt(p.reserve_a_raw || "0")) / 10 ** (p.decimals_a ?? 18);
    } else {
      volSym = p.symbol_b || "?";
      Ruse = parseFloat(BigInt(p.reserve_b_raw || "0")) / 10 ** (p.decimals_b ?? 18);
    }

    html += `<h2>Price impact threshold - ${esc(p.label)}</h2>`;
    html += `<div class="notice"><strong>Current price: <span class="num">${fmtUsd(p.price)}</span></strong>
      <span class="muted small"> - updated ${ago(p.updated_at)} - reserves recompute this table every poll</span></div>`;
    html += `<div class="banner info">No-fee approximation using constant product x times y equals k against current reserves. Real AMM trades typically add about 0.3 percent per trade in fees on top of these amounts.</div>`;
    html += `<div class="section-head"><label class="small muted" for="poolPick">Pool</label>
      <select id="poolPick" class="field-select">${priced.map(x => `<option value="${x.address}" ${x.address === sel ? "selected" : ""}>${esc(x.label)}</option>`).join("")}</select></div>`;

    const rows = impactRows(Ruse);
    html += `<div class="grid cols-2" style="align-items:start">
      <div class="tablewrap" style="max-height:480px;overflow-y:auto"><table><thead><tr>
        <th class="num">Price change</th><th>Direction</th><th class="num">Resulting price</th><th class="num">${esc(volSym)} needed</th></tr></thead><tbody>`;
    for (const r of rows) {
      const targetPrice = p.price * r.ratio;
      html += `<tr><td class="num">${r.pct > 0 ? "+" : ""}${r.pct}%</td>
        <td class="small muted">${r.pct < 0 ? "sell into pool" : r.pct > 0 ? "buy from pool" : "-"}</td>
        <td class="num">${fmtUsd(targetPrice)}</td>
        <td class="num">${NF0.format(r.amount)}</td></tr>`;
    }
    html += `</tbody></table></div>
      <div>${renderImpactLine(Ruse, volSym, p.price)}</div>
    </div>`;

    /* observed events: intervals carry bps, swaps carry seller + amount */
    const intervals = d.large_sells.filter(s => s.kind !== "swap" && s.impact_bps !== null).slice(0, 30);
    const swaps = d.large_sells.filter(s => s.kind === "swap").slice(0, 40);
    html += `<h2>Observed price impact intervals</h2>`;
    if (!intervals.length) {
      html += empty("No large sell intervals detected yet. Threshold is a 50 basis point move between polls on stable-priced pools.");
    } else {
      html += `<div class="tablewrap"><table><thead><tr>
        <th>When</th><th>Pool</th><th class="num">Move</th><th class="num">Price before</th><th class="num">Price after</th></tr></thead><tbody>`;
      for (const s of intervals) {
        html += `<tr><td class="num muted small">${fmtTs(s.ts)}</td><td class="mono small">${poolLabel(d.pools, s.pool)}</td>
          <td>${status(s.impact_bps < 0 ? "bad" : "warn", (s.impact_bps > 0 ? "+" : "") + NF2.format(s.impact_bps) + " bps")}</td>
          <td class="num">${fmtUsd(s.price_before)}</td><td class="num">${fmtUsd(s.price_after)}</td></tr>`;
      }
      html += `</tbody></table></div>`;
    }

    html += `<h2>Attributed swaps - all pools</h2>`;
    if (!swaps.length) {
      html += empty("No swaps decoded yet. Swap logs are scanned every 5 minutes over the recent block window.");
    } else {
      const { slice, controls } = paginate("dexSwaps", swaps, 25);
      html += `<div class="tablewrap"><table><thead><tr>
        <th>When</th><th>Pool</th><th>Seller</th><th class="num">Amount sold</th><th>Tx</th></tr></thead><tbody>`;
      for (const s of slice) {
        let amt = "-";
        if (s.rbnt_sold_raw && s.rbnt_sold_raw.includes(":")) {
          const [sym, raw] = s.rbnt_sold_raw.split(":");
          amt = fmtRaw(raw) + " " + sym;
        }
        html += `<tr><td class="num muted small">${fmtTs(s.ts)}</td>
          <td class="mono small">${poolLabel(d.pools, s.pool)}</td>
          <td>${s.seller ? addrLink(s.seller) : "-"}</td>
          <td class="num">${amt}</td>
          <td class="mono small"><a class="accent-link" href="https://redbelly.routescan.io/tx/${s.tx_hash}" target="_blank" rel="noopener">${s.tx_hash.slice(0, 10)}...${s.tx_hash.slice(-6)}</a></td></tr>`;
      }
      html += `</tbody></table></div>${controls}`;
    }
  }

  /* swaps by pool donut */
  if (d.swaps_by_pool && d.swaps_by_pool.length) {
    const totalSwaps = d.swaps_by_pool.reduce((a, s) => a + s.n, 0);
    html += `<h2>Attributed swaps - all pools</h2>`;
    html += `<p class="muted small">${NF0.format(totalSwaps)} swaps decoded from each pool's own Swap event log (standard Uniswap-V2 signature, confirmed against the verified pair source on Routescan).</p>
      <div id="donutSwaps"></div>`;
  }

  /* native RBNT holders - best effort among known addresses */
  html += `<h2>Top RBNT holders - native</h2>`;
  if (!d.native_holders || !d.native_holders.length) {
    html += empty("Native balance scan has not completed its first pass yet.");
  } else {
    const { slice, controls } = paginate("dexNative", d.native_holders, 25);
    html += `<div class="banner info">${esc(d.native_note)}.</div>`;
    html += `<div class="tablewrap"><table><thead><tr>
      <th>#</th><th>Wallet</th><th class="num">RBNT native</th><th>Checked</th></tr></thead><tbody>`;
    d.native_holders.forEach((h, i) => {
      html += `<tr><td class="num muted">${i + 1}</td>
        <td>${addrLink(h.wallet)}</td>
        <td class="num">${fmtRaw(h.balance_raw)}</td>
        <td class="num muted small">${ago(h.updated_at)}</td></tr>`;
    });
    html += `</tbody></table></div>${controls}`;
  }

  html += `<h2>Top WRBNT holders - wrapped</h2>`;
  if (!d.top_holders.length) {
    html += empty("Holder snapshot not taken yet.");
  } else {
    const { slice, controls } = paginate("dexHolders", d.top_holders, 25);
    html += `<div class="tablewrap"><table><thead><tr>
      <th>Wallet</th><th class="num">WRBNT</th><th>Venue</th><th>Confidence</th></tr></thead><tbody>`;
    for (const h of slice) {
      html += `<tr><td>${addrLink(h.wallet)}</td>
        <td class="num">${fmtRaw(h.balance_raw)}</td>
        <td class="mono small">${esc(h.venue)}</td>
        <td>${confStatus(h.confidence)}</td></tr>`;
    }
    html += `</tbody></table></div>${controls}`;
  }
  $view.innerHTML = html;
  if (d.swaps_by_pool && d.swaps_by_pool.length) {
    setChart("donutSwaps", renderBars({
      horizontal: true, height: 220,
      data: (d.swaps_by_pool || []).map(s => {
        const p = d.pools.find(x => x.address === s.pool);
        return { label: p ? p.label : s.pool.slice(0, 8), values: { n: s.n } };
      }),
      series: [{ key: "n", label: "Attributed swaps", color: "#EF5350" }],
    }));
  }
  bindPagers(() => route(activeRoute, true));
  document.getElementById("poolPick")?.addEventListener("change", e => {
    window._impactPool = e.target.value;
    route(activeRoute, true);
  });
}

function poolLabel(pools, address) {
  const p = pools.find(x => x.address === address);
  return p ? p.label : address.slice(0, 10) + "...";
}

/* ---------- Page 4: CEX ---------- */
async function renderCex() {
  const d = await api("/api/cex");
  let html = `<h1>CEX venues</h1>`;

  if (d.market && d.market.price_usd !== null) {
    html += `<section class="grid cols-3">
      ${statCard("Price", fmtUsd(d.market.price_usd), "CoinGecko aggregate")}
      ${statCard("Market cap", d.market.market_cap ? "$" + NF0.format(Math.round(d.market.market_cap)) : "-", "aggregate price x circulating supply - token-wide, does not split by venue")}
      ${statCard("Snapshot", ago(d.market.ts), "refreshes every 10 minutes")}
    </section>`;
    if (d.volume_share && d.volume_share.length) {
      const totVol = d.volume_share.reduce((a, v) => a + v.volume_usd, 0);
      html += `<h2>24h volume share by venue</h2>
        <div id="donutVolume"></div>
        <p class="muted small">${esc(d.volume_note)}. BYDFi does not appear in CoinGecko tickers right now, so it has no segment.</p>`;
    }
  } else {
    html += empty("Market snapshot unavailable right now.");
  }

  html += `<div class="banner">Exchange hot-wallet attribution is best effort. Exchanges do not publish hot-wallet addresses. Anchors below come from manual test deposits; everything else is clustered or unconfirmed and labeled as such.</div>`;

  html += `<h2>Anchors</h2>`;
  html += `<form id="anchorForm" class="card" style="max-width:640px">
    <div class="field"><label for="ex">Exchange</label>
      <input id="ex" name="exchange" placeholder="gate" autocomplete="off">
      <span class="error">Enter an exchange name.</span></div>
    <div class="field"><label for="ad">Confirmed deposit address</label>
      <input id="ad" name="address" placeholder="0x..." autocomplete="off">
      <span class="error">Enter a valid 42 character address.</span></div>
    <button class="btn primary" type="submit">Add anchor</button>
  </form>`;
  if (d.anchors.length) {
    const { slice, controls } = paginate("cexAnchors", d.anchors, 25);
    html += `<div class="tablewrap" style="margin-top:16px"><table><thead><tr><th>Exchange</th><th>Address</th><th>Confidence</th><th>Added</th><th></th></tr></thead><tbody>`;
    for (const a of slice) {
      html += `<tr><td><strong>${esc(a.exchange)}</strong></td>
        <td>${addrLink(a.address)}</td>
        <td>${confStatus(a.confidence)}</td>
        <td class="num muted small">${fmtTs(a.added_at)}</td>
        <td><button class="btn ghost del-anchor" data-ex="${esc(a.exchange)}" data-ad="${esc(a.address)}">Remove</button></td></tr>`;
    }
    html += `</tbody></table></div>${controls}`;
  } else {
    html += empty("No anchors yet. Add one per exchange after sending a small test deposit.");
  }

  html += `<h2>Clustered candidates</h2>`;
  if (!d.clusters.length) {
    html += empty("Nothing clustered yet. Clustering expands from anchors through on-chain flow analysis every hour.");
  } else {
    const { slice, controls } = paginate("cexClusters", d.clusters, 25);
    html += `<div class="tablewrap"><table><thead><tr>
      <th>Exchange</th><th>Address</th><th class="num">Score</th><th class="num">Inflows</th><th>Confidence</th></tr></thead><tbody>`;
    for (const c of slice) {
      html += `<tr><td>${esc(c.exchange)}</td><td>${addrLink(c.address)}</td>
        <td class="num">${NF2.format(c.score)}</td><td class="num">${NF0.format(c.inflow_sources || 0)}</td>
        <td>${status("warn", "clustered")}</td></tr>`;
    }
    html += `</tbody></table></div>${controls}`;
  }
  $view.innerHTML = html;
  if (d.volume_share && d.volume_share.length) {
    const nameMap = { mxc: "MEXC", gate: "Gate", whitebit: "WhiteBIT", "uniswap-v4-ethereum": "Uniswap v4 (bridged)" };
    setChart("donutVolume", renderBars({
      horizontal: true, height: 200,
      data: d.volume_share.map(v => ({ label: nameMap[v.exchange] || v.exchange,
        values: { usd: Math.round(v.volume_usd) } })),
      series: [{ key: "usd", label: "24h volume USD", color: "#EF5350" }],
    }));
  }
  bindPagers(() => route(activeRoute, true));

  document.getElementById("anchorForm").addEventListener("submit", async e => {
    e.preventDefault();
    const ex = document.getElementById("ex").value.trim();
    const ad = document.getElementById("ad").value.trim();
    document.getElementById("ex").parentElement.classList.toggle("invalid", !ex);
    document.getElementById("ad").parentElement.classList.toggle("invalid", !/^0x[0-9a-fA-F]{40}$/.test(ad));
    if (!ex || !/^0x[0-9a-fA-F]{40}$/.test(ad)) return;
    await fetch("/api/admin/anchors", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ exchange: ex, address: ad }) });
    route(activeRoute, true);
  });
  document.querySelectorAll(".del-anchor").forEach(b => b.addEventListener("click", async () => {
    await fetch(`/api/admin/anchors/${encodeURIComponent(b.dataset.ex)}/${encodeURIComponent(b.dataset.ad)}`, { method: "DELETE" });
    route(activeRoute, true);
  }));
}

/* ---------- Page 5: Holders (combined DEX + CEX) ---------- */
async function renderMega() {
  const d = await api("/api/mega");
  let html = `<h1>Holders - combined DEX + CEX</h1>`;

  html += `<h2>Holder concentration</h2>
    <div id="donutConc"></div>
    <div id="holderDist" style="margin-top:16px"></div>`;
  html += `<h2>Merged top holders</h2>`;
  if (!d.top_holders.length) {
    html += empty("Holder snapshots not ready yet.");
  } else {
    html += `<div id="megaBoardHost"></div>`;
    html += `<p class="muted small">Addresses are deduplicated across venue types. Confidence labels carry over from each source.</p>`;
  }

  html += `<h2>Cross-venue price impact</h2>`;
  if (!d.combined_impact.length) {
    html += empty("No cross-venue events yet. A flag appears when a Reddex sell interval lines up with an aggregate price move inside the same 15 minute window.");
  } else {
    html += `<div id="megaImpactHost"></div>`;
  }

  html += `<h2>Supply reconciliation</h2>`;
  const rows = (d.bridged_supply || []).map(b =>
    `<tr><td>${esc(b.chain)}</td><td>${b.address ? addrLink(b.address) : "-"}</td>
     <td class="num">${b.supply_raw ? fmtRaw(b.supply_raw) : "-"}</td>
     <td>${b.reachable ? status("ok", "reachable") : status("bad", "unreachable here")}</td></tr>`).join("");
  html += `<div class="tablewrap"><table><thead><tr><th>Chain</th><th>Contract</th><th class="num">Supply</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  html += `<div class="banner">Known open item: total WRBNT claimed across signup managers exceeds the Ecosystem bucket balance. The wrap and mint relationship between native RBNT and WRBNT is not fully traced. On-chain balances above are ground truth. Bucket level tokenomics percentages are context only and are not reconciled here.</div>`;
  html += `<div class="banner">Unreachable means this host could not read the chain right now, not that the token is gone. Solana public RPC rate limits often cause this.</div>`;
  $view.innerHTML = html;
  if (d.top_holders.length) {
    const top10 = d.top_holders.slice(0, 10).reduce((a, h) => a + BigInt(h.balance_raw), 0n);
    const rest = d.top_holders.slice(10).reduce((a, h) => a + BigInt(h.balance_raw), 0n);
    setChart("donutConc", renderBars({
      horizontal: true, height: 160,
      data: [{ label: "Top 10", values: { wrbnt: Number(top10 / 10n ** 12n) / 1e6 } },
             { label: "Ranks 11-150", values: { wrbnt: Number(rest / 10n ** 12n) / 1e6 } }],
      series: [{ key: "wrbnt", label: "WRBNT (millions)", color: "#EF5350" }],
    }));

    /* top-holder distribution: WRBNT + native RBNT */
    const distHost = document.getElementById("holderDist");
    if (distHost) {
      const wrbntTop = d.top_holders.slice(0, 10).map(h => ({
        label: h.wallet.slice(0, 8), values: { v: Number(BigInt(h.balance_raw) / 10n ** 12n) / 1e6 } }));
      const nativeTop = (d.native_holders || []).slice(0, 10).map(h => ({
        label: h.wallet.slice(0, 8), values: { v: Number(BigInt(h.balance_raw) / 10n ** 12n) / 1e6 } }));
      distHost.innerHTML =
        `<div class="grid cols-2">
          <div class="card"><h3>Top WRBNT holders - distribution</h3><div id="distW"></div></div>
          <div class="card"><h3>Top native RBNT holders - distribution</h3><div id="distN"></div></div>
        </div>`;
      document.getElementById("distW").innerHTML = renderBars({ data: wrbntTop,
        series: [{ key: "v", label: "WRBNT (millions)", color: "#EF5350" }], height: 300 });
      document.getElementById("distN").innerHTML = renderBars({ data: nativeTop,
        series: [{ key: "v", label: "RBNT native (millions)", color: "#FCD34D" }], height: 300 });
    }

    /* searchable merged holders table */
    window._tblFilters = window._tblFilters || {};
    const renderBoard = () => {
      const host = document.getElementById("megaBoardHost");
      if (!host) return;
      const key = "megaBoard";
      const q = (window._tblFilters[key] || "");
      const filtered = q ? d.top_holders.filter(h => h.wallet.toLowerCase().includes(q)) : d.top_holders;
      let inner = searchInput(key + "-search", "Filter by wallet address", q);
      if (!filtered.length) {
        inner += `<p class="muted small">No wallet found${q ? ` matching "${esc(q)}"` : ""}.</p>`;
        host.innerHTML = inner;
        wireSearch(key + "-search", v => { window._tblFilters[key] = v; renderBoard(); }, q);
        return;
      }
      const { slice, controls } = paginate(key, filtered, 25);
      inner += `<div class="tablewrap"><table><thead><tr>
        <th>Wallet</th><th class="num">WRBNT</th><th>Venues</th><th>Confidence</th></tr></thead><tbody>`;
      for (const h of slice) {
        inner += `<tr><td>${addrLink(h.wallet)}</td>
          <td class="num">${fmtRaw(h.balance_raw)}</td>
          <td class="mono small">${h.venues.map(esc).join(", ")}</td>
          <td>${confStatus(h.confidence)}</td></tr>`;
      }
      inner += `</tbody></table></div>${controls}`;
      host.innerHTML = inner;
      wireSearch(key + "-search", v => { window._tblFilters[key] = v; renderBoard(); }, q);
      bindPagers(renderBoard);
    };
    renderBoard();
  }

  /* cross-venue feed: local pagination */
  const impactHost = document.getElementById("megaImpactHost");
  if (impactHost) {
    const renderImpact = () => {
      const { slice, controls } = paginate("megaImpact", d.combined_impact, 25);
      let inner = `<div class="tablewrap"><table><thead><tr><th>When</th><th>Pool</th><th class="num">Pool move</th><th class="num">Aggregate price at window</th></tr></thead><tbody>`;
      for (const r of slice) {
        const both = r.price_usd !== null && r.impact_bps !== null && Math.abs(r.impact_bps) >= 50;
        inner += `<tr><td class="num muted small">${fmtTs(r.ts)}</td><td class="mono small">${r.pool}</td>
          <td>${status(r.impact_bps < 0 ? "bad" : "warn", NF2.format(r.impact_bps) + " bps")}</td>
          <td class="num">${both ? fmtUsd(r.price_usd) : "-"}</td></tr>`;
      }
      inner += `</tbody></table></div>${controls}`;
      impactHost.innerHTML = inner;
      bindPagers(renderImpact, impactHost);
    };
    renderImpact();
  }
}

/* ---------- Page 0: Home ---------- */
const ORBITAL_ICONS = {
  operators: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="5" r="2.2"/><circle cx="5" cy="19" r="2.2"/><circle cx="19" cy="19" r="2.2"/><path d="M12 7.2v3.8M6.6 17.2l3.6-4.4M17.4 17.2l-3.6-4.4"/></svg>`,
  treasury: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>`,
  dex: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3l5 5-5 5M21 8H7"/><path d="M8 21l-5-5 5-5M3 16h14"/></svg>`,
  cex: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></svg>`,
  holders: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.21 15.89A10 10 0 1 1 8 2.83"/><path d="M22 12A10 10 0 0 0 12 2v10z"/></svg>`,
};

function renderOrbitalMarkup(items) {
  return `<div class="orbital" id="orbital"><div class="orbital-stage">
    <div class="orb-center"><span class="orb-ping"></span><span class="orb-ping" style="animation-delay:.9s"></span></div>
    <div class="orb-ring"></div>
    ${items.map(it => `
      <div class="orb-node" data-id="${it.id}">
        <div class="orb-node-icon">${it.icon}</div>
        <div class="orb-node-title">${esc(it.title)}</div>
        <div class="orb-card" hidden>
          <p class="orb-desc">${esc(it.content)}</p>
          <div class="stat-line"><span>${esc(it.statLabel)}</span><b>${esc(it.statValue)}</b></div>
          <div class="stat-line"><span>${esc(it.energyLabel)}</span><b>${it.energy}%</b></div>
          <div class="orb-energy"><i style="width:${Math.max(2, Math.min(100, it.energy))}%"></i></div>
          <a class="orb-cta" href="#/${it.route}">View section
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
          </a>
        </div>
      </div>`).join("")}
  </div></div>`;
}

function initOrbital(items) {
  const wrapEl = document.getElementById("orbital");
  if (!wrapEl) return;
  const nodes = [...wrapEl.querySelectorAll(".orb-node")];
  let rot = 0, auto = true, timer = null, expandedIdx = null;

  const radius = () => Math.min(200, Math.max(110, wrapEl.clientWidth / 2 - 80));
  const pos = (i, total) => {
    const ang = ((i / total) * 360 + rot) % 360;
    const rad = ang * Math.PI / 180;
    const r = radius();
    return { x: r * Math.cos(rad), y: r * Math.sin(rad),
             z: Math.round(100 + 50 * Math.cos(rad)),
             o: Math.max(.45, Math.min(1, .45 + .55 * ((1 + Math.sin(rad)) / 2))) };
  };
  const apply = () => {
    nodes.forEach((n, i) => {
      const p = pos(i, nodes.length);
      n.style.transform = `translate(${p.x}px, ${p.y}px)`;
      n.style.zIndex = expandedIdx === i ? 200 : p.z;
      n.style.opacity = expandedIdx === i ? 1 : p.o;
    });
  };
  const start = () => { if (!timer) timer = setInterval(() => { rot = (rot + .3) % 360; apply(); }, 50); };
  const stop = () => { clearInterval(timer); timer = null; };

  nodes.forEach((n, i) => {
    const card = n.querySelector(".orb-card");
    n.addEventListener("click", e => {
      e.stopPropagation();
      if (e.target.closest(".orb-cta")) return; // CTA navigates natively
      if (expandedIdx === i) { location.hash = "#/" + items[i].route; return; }
      expandedIdx = i;
      stop();
      // rotate the ring so the chosen node sits at the top
      rot = (270 - (i / nodes.length) * 360 + 360) % 360;
      nodes.forEach(m => { m.classList.toggle("expanded", m === n); m.querySelector(".orb-card").hidden = m !== n; });
      apply();
    });
    n.addEventListener("mouseenter", stop);
  });
  wrapEl.addEventListener("click", e => {
    if (e.target === wrapEl || e.target.classList.contains("orbital-stage") || e.target.classList.contains("orb-ring") || e.target.classList.contains("orb-center")) {
      expandedIdx = null;
      nodes.forEach(m => { m.classList.remove("expanded"); m.querySelector(".orb-card").hidden = true; });
      start();
    }
  });
  window.addEventListener("resize", () => { if (!timer) apply(); else apply(); });
  apply();
  start();
}

async function renderHome() {
  let priceHtml = "", price = null, claimers = "-", cap = "-";
  let opsData, dexData, cexData, treasData, megaData;
  try {
    [dexData, opsData, cexData, treasData, megaData] = await Promise.all([
      api("/api/dex"), api("/api/node-operators?scope=primary"), api("/api/cex"),
      api("/api/treasury"), api("/api/mega"),
    ]);
    const pool = (dexData.pools || []).find(p => p.label === "WRBNT/USDC.e");
    if (pool && pool.price) {
      let volSym, Ruse;
      if ((pool.symbol_b === "USDC.e" || pool.symbol_b === "USDT")) {
        volSym = pool.symbol_a || "WRBNT";
        Ruse = parseFloat(BigInt(pool.reserve_a_raw || "0")) / 10 ** (pool.decimals_a ?? 18);
      } else {
        volSym = pool.symbol_b || "WRBNT";
        Ruse = parseFloat(BigInt(pool.reserve_b_raw || "0")) / 10 ** (pool.decimals_b ?? 18);
      }
      price = pool.price;
      priceHtml = `<h2>What a large sell does to price - WRBNT/USDC.e live</h2>
        <div class="notice"><strong>Current price: <span class="num">${fmtUsd(pool.price)}</span></strong>
        <span class="muted small"> - updated ${ago(pool.updated_at)} - recomputed on every reserve poll</span></div>
        ${renderImpactLine(Ruse, volSym, pool.price)}
        <p class="muted small">No-fee approximation from constant product reserves. Real trades add about 0.3 percent in fees. Full table on the DEX page.</p>`;
    }
    if (opsData) claimers = NF0.format(opsData.unique_claimers);
    if (cexData && cexData.market) cap = cexData.market.market_cap ? "$" + NF0.format(Math.round(cexData.market.market_cap)) : "-";
  } catch (e) { /* hero still renders */ }

  /* real orbital stats pulled from the same numbers each section already shows */
  const rosterSize = opsData ? opsData.roster_size : 0;
  const claimersN = opsData ? opsData.unique_claimers : 0;
  const poolsTracked = dexData ? dexData.pools.length : 0;
  const venuesWatched = Math.min(4, (cexData && cexData.volume_share) ? cexData.volume_share.length : 0);
  const mergedCount = megaData && megaData.top_holders ? megaData.top_holders.length : 0;
  const treasSum = treasData
    ? treasData.wallets.reduce((a, w) => a + BigInt(w.eth_native_raw || "0"), 0n)
    : 0n;

  const items = [
    { id: 1, title: "Node Operators", route: "operators", icon: ORBITAL_ICONS.operators,
      content: "Who signed up for node-operator rewards, who has claimed, and who is still holding versus selling.",
      statLabel: "claimed / roster", statValue: `${NF0.format(claimersN)} / ${NF0.format(rosterSize)}`,
      energyLabel: "roster claimed", energy: rosterSize ? Math.round(claimersN / rosterSize * 100) : 0 },
    { id: 2, title: "Treasury", route: "treasury", icon: ORBITAL_ICONS.treasury,
      content: "Team, reserve, ecosystem and DAO wallets with live native and wrapped balances, labeled official or inferred.",
      statLabel: "RBNT in tagged wallets", statValue: formatCompact(Number(treasSum / 10n ** 12n) / 1e6),
      energyLabel: "of 10B supply held", energy: Math.min(100, Math.round(Number(treasSum) / 1e18 / 10 * 1)) },
    { id: 3, title: "DEX", route: "dex", icon: ORBITAL_ICONS.dex,
      content: "All Reddex pools resolved from the factory contract, live prices every 2 minutes, and what each sell size does to price.",
      statLabel: "pools tracked", statValue: `${poolsTracked} / 7`,
      energyLabel: "of known pools", energy: Math.round(poolsTracked / 7 * 100) },
    { id: 4, title: "CEX", route: "cex", icon: ORBITAL_ICONS.cex,
      content: "Aggregate price and market cap plus best-effort hot-wallet attribution with honest confidence labels.",
      statLabel: "venues with data", statValue: `${venuesWatched} / 4`,
      energyLabel: "of target venues", energy: Math.min(100, Math.round(venuesWatched / 4 * 100)) },
    { id: 5, title: "Holders", route: "holders", icon: ORBITAL_ICONS.holders,
      content: "Merged top holders across DEX and CEX data deduplicated by address, plus supply reconciliation across chains.",
      statLabel: "wallets merged", statValue: NF0.format(mergedCount),
      energyLabel: "of top-250 target", energy: Math.min(100, Math.round(mergedCount / 250 * 100)) },
  ];

  let html = `<section class="hero">
    <h1>Live on-chain data for Redbelly Network's RBNT token.</h1>
    <p>Who holds it, who is claiming node-operator rewards, what a large sell does to price. Every number comes straight from Redbelly mainnet and Reddex, refreshed every few minutes.</p>
    <section class="grid cols-3 hero-stats">
      ${statCard("WRBNT price", fmtUsd(price), "Reddex WRBNT/USDC.e")}
      ${statCard("Verified manager claimants", claimers, "manager 0x7199...d7fC")}
      ${statCard("Market cap", cap, "CoinGecko aggregate")}
    </section>
  </section>
  <h2>Navigate the sections</h2>
  ${renderOrbitalMarkup(items)}
  <p class="muted small">Click a node to see its live stat. Click again or use View section to open it.</p>
  <div id="homeImpact">${priceHtml}</div>`;
  $view.innerHTML = html;
  initOrbital(items);
}

/* ---------- Wallet profile (global search target) ---------- */
async function renderWallet(address) {
  let d;
  try {
    d = await api("/api/wallet/" + address);
  } catch (e) {
    $view.innerHTML = `<h1>Wallet profile</h1>` + empty("Could not read that address. " + e.message);
    return;
  }
  const isKnown = !(d.identities.length === 1 && d.identities[0].type === "unknown");
  const isOperator = d.identities.some(i => i.type === "node-operator");
  let html = `<h1>Wallet profile</h1>
    <p class="mono" style="word-break:break-all">${addrLink(d.address)}</p>`;
  html += `<section class="grid cols-3">
    ${statCard("RBNT native", fmtRaw(d.native_balance_raw))}
    ${statCard("WRBNT wrapped", fmtRaw(d.wrbnt_balance_raw))}
    ${statCard("Read", ago(d.queried_at), "live RPC lookup")}
  </section>`;

  /* explicit yes/no operator line */
  if (isOperator) {
    const mgrKinds = [...new Set(d.identities.filter(i => i.type === "node-operator").map(i => i.manager_kind))];
    html += `<div class="notice"><strong>Node operator: yes</strong>
      <span class="muted small"> - on ${mgrKinds.join(" + ") || "vesting"} roster${d.stats ? ` - ${NF0.format(d.stats.claims_count)} claims totaling ${fmtRaw(d.stats.claimed_total_raw)} WRBNT` : ", no claims yet"}</span></div>`;
  } else {
    html += `<div class="notice"><strong>Node operator: no</strong>
      <span class="muted small"> - not on either factory roster</span></div>`;
  }

  /* holdings donuts */
  html += `<section class="grid cols-2">
    <div class="card"><h3>Holdings split</h3><div id="walletDonut"></div></div>
    <div class="card"><h3>Claims vs still holding</h3><div id="walletClaimDonut"></div></div>
  </section>`;

  html += `<h2>Identification</h2>`;
  html += `<div class="tablewrap"><table><thead><tr><th>Type</th><th>Detail</th><th>Confidence</th></tr></thead><tbody>`;
  for (const id of d.identities) {
    html += `<tr><td class="mono small">${esc(id.type)}</td>
      <td>${id.manager ? addrLink(id.manager) : esc(id.detail || "-")}</td>
      <td>${confStatus(id.confidence)}</td></tr>`;
  }
  html += `</tbody></table></div>`;
  if (!isKnown) {
    html += `<p class="muted small">Balances above are still exact - this address just does not match any roster, treasury, pool or CEX table this app tracks.</p>`;
  }

  /* node operator detail */
  if (d.stats && d.stats.claims_count > 0) {
    const s = d.stats;
    html += `<h2>Claim history - node operator</h2>`;
    html += `<section class="grid cols-4">
      ${statCard("Claims", NF0.format(s.claims_count))}
      ${statCard("Total claimed WRBNT", fmtRaw(s.claimed_total_raw))}
      ${statCard("First claim", fmtTs(s.first_claim_ts).slice(0, 11))}
      ${statCard("Last claim", fmtTs(s.last_claim_ts).slice(0, 11))}
    </section>`;
    html += `<p>Sell signal: ${sellSignal(s)}</p>`;
    const { slice, controls } = paginate(`walletClaims-${d.address}`, d.recent_claims, 25);
    html += `<div class="tablewrap"><table><thead><tr><th>When</th><th>Manager</th><th class="num">Amount</th><th>Tx</th></tr></thead><tbody>`;
    for (const c of slice) {
      html += `<tr><td class="num muted small">${fmtTs(c.ts)}</td>
        <td>${addrLink(c.manager)}</td>
        <td class="num">${fmtRaw(c.value_raw)}</td>
        <td class="mono small"><a class="accent-link" href="https://redbelly.routescan.io/tx/${c.tx_hash}" target="_blank" rel="noopener">${c.tx_hash.slice(0, 10)}...${c.tx_hash.slice(-6)}</a></td></tr>`;
    }
    html += `</tbody></table></div>${controls}`;
  }

  /* vesting windows */
  if (d.vestings.length) {
    html += `<h2>Vesting windows</h2>`;
    const { slice, controls } = paginate(`walletVest-${d.address}`, d.vestings, 25);
    html += `<div class="tablewrap"><table><thead><tr>
      <th>Program</th><th>Window</th><th>Status</th><th class="num">Claimed / allocated</th><th>Starts</th><th>Ends</th></tr></thead><tbody>`;
    for (const v of slice) {
      const alloc = BigInt(v.linear_amount_raw || 0) + BigInt(v.cliff_amount_raw || 0) + BigInt(v.initial_unlock_raw || 0);
      html += `<tr><td class="mono small">${esc(v.kind)}</td>
        <td class="mono small">${esc(v.window_label || "part1")}</td>
        <td>${stateStatus(v.state)}</td>
        <td class="num">${fmtRaw(v.released_or_claimed_raw)} / ${fmtRaw(alloc.toString())}</td>
        <td class="num muted small">${fmtTs(v.start_ts)}</td>
        <td class="num muted small">${fmtTs(v.end_ts)}</td></tr>`;
    }
    html += `</tbody></table></div>${controls}`;
    html += `<div class="banner">Jailing can extend vesting and tombstoning ends it and forfeits the unvested balance. States come from the manager contract records.</div>`;
  }
  $view.innerHTML = html;

  /* holdings bar: value both balances at the aggregate price for a fair split */
  try {
    const m = await api("/api/cex");
    const px = m.market && m.market.price_usd ? m.market.price_usd : null;
    if (px) {
      const natUsd = Number(BigInt(d.native_balance_raw)) / 1e18 * px;
      const wUsd = Number(BigInt(d.wrbnt_balance_raw)) / 1e18 * px;
      setChart("walletDonut", renderBars({
        horizontal: true, height: 150,
        data: [
          { label: "Native RBNT", values: { usd: Math.round(natUsd * 100) / 100 } },
          { label: "WRBNT wrapped", values: { usd: Math.round(wUsd * 100) / 100 } },
        ],
        series: [{ key: "usd", label: "USD value at aggregate price", color: "#EF5350" }],
      }));
    }
  } catch (e) { /* chart optional */ }

  /* claimed vs still holding for operators */
  if (isOperator && d.stats && BigInt(d.stats.claimed_total_raw) > 0n) {
    const claimed = BigInt(d.stats.claimed_total_raw);
    const bal = BigInt(d.wrbnt_balance_raw || "0");
    const held = claimed < bal ? claimed : bal;
    const sold = claimed > held ? claimed - held : 0n;
    setChart("walletClaimDonut", renderBars({
      horizontal: true, height: 150,
      data: [{ label: "From claims", values: {
        held: Number(held / 10n ** 12n) / 1e6,
        sold: Number(sold / 10n ** 12n) / 1e6 } }],
      series: [{ key: "held", label: "Still holding (WRBNT)", color: "#86EFAC" },
               { key: "sold", label: "Sold lower bound (WRBNT)", color: "#EF5350" }],
    }));
  }
  bindPagers(() => route(activeRoute, true));
}

/* ---------- router ---------- */
const ROUTES = {
  home: { title: "Home", fn: renderHome },
  operators: { title: "Node operators", fn: renderOperators },
  treasury: { title: "Treasury", fn: renderTreasury },
  dex: { title: "DEX", fn: renderDex },
  cex: { title: "CEX", fn: renderCex },
  holders: { title: "Holders", fn: renderMega },
};

async function route(name, force) {
  name = (name || "home").replace(/^#\/?/, "").replace(/\/$/, "");
  if (name === "mega") name = "holders"; // old links keep working
  const tabKey = name.startsWith("wallet/") ? "" : name;
  moveIndicator(tabKey);
  document.querySelectorAll("#nav a").forEach(a => a.classList.toggle("active", a.dataset.route === name));
  if (name === activeRoute && !force) return;
  activeRoute = name;
  // keep the previous section visible while the new one loads - no blank cut
  if (!$view.firstElementChild) {
    $view.innerHTML = `<section class="card"><p class="muted">Connecting to Redbelly mainnet...</p></section>`;
  }
  $view.classList.add("route-loading");
  try {
    if (name.startsWith("wallet/")) {
      await renderWallet(name.slice(7));
    } else {
      if (!ROUTES[name]) name = "home";
      await ROUTES[name].fn();
    }
    animateIn();
    // background refresh: put the reader back exactly where they were
    if (window._restoreScroll != null) {
      window.scrollTo(0, window._restoreScroll);
      window._restoreScroll = null;
    }
  } catch (e) {
    $view.innerHTML = `<div class="card"><p>Could not load data. ${esc(e.message)}</p><p class="muted">Retry happens automatically every 30 seconds.</p></div>`;
    animateIn();
  } finally {
    $view.classList.remove("route-loading");
  }
}

window.addEventListener("hashchange", () => route(location.hash));

document.getElementById("walletSearch").addEventListener("submit", e => {
  e.preventDefault();
  const v = document.getElementById("searchAddr").value.trim();
  const input = document.getElementById("searchAddr");
  if (/^0x[0-9a-fA-F]{40}$/.test(v)) {
    input.value = "";
    location.hash = "#/wallet/" + v.toLowerCase();
    route(location.hash, true);
  } else {
    input.style.borderColor = "#DC2626";
    setTimeout(() => input.style.borderColor = "", 1200);
  }
});

/* ---------- theme ---------- */
const SUN_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>`;
const MOON_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;

function initTheme() {
  const saved = localStorage.getItem("rbnt-theme");
  const prefersLight = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches;
  const theme = saved || (prefersLight ? "light" : "dark");
  applyTheme(theme);
  document.getElementById("themeToggle").addEventListener("click", () => {
    applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");
  });
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("rbnt-theme", theme);
  const toggle = document.getElementById("themeToggle");
  if (toggle) toggle.innerHTML = theme === "light" ? MOON_SVG : SUN_SVG;
}

async function boot() {
  initTheme();
  await route(location.hash || "#/");
  refreshTimer = setInterval(() => {
    if (activeRoute && activeRoute.startsWith("wallet/")) return;
    if (document.hidden) return;                       // tab in background: skip
    if (activeRoute === "home" && document.querySelector(".orb-node.expanded")) return; // dont close orbital mid-read
    window._restoreScroll = window.scrollY;            // re-render without moving the page
    route(activeRoute || "home", true);
  }, REFRESH_MS);
}
boot();
