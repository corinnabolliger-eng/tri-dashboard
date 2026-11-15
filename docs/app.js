/* Triathlon dashboard — plain JS, no dependencies. */
"use strict";

const SPORTS = [
  { key: "swim", name: "Swim", color: "var(--swim)" },
  { key: "bike", name: "Bike", color: "var(--bike)" },
  { key: "run", name: "Run", color: "var(--run)" },
  { key: "other", name: "Other", color: "var(--other)" },
];
const SPORT = Object.fromEntries(SPORTS.map((s) => [s.key, s]));
const ZONE_COLORS = ["var(--z1)", "var(--z2)", "var(--z3)", "var(--z4)", "var(--z5)"];
const PW_KEY = "tri-dashboard-pw";

let CONFIG = {};
let DATA = null;
let M = null; // derived model
const state = { pmcDays: 180, volMetric: "hours" };

/* ------------------------------------------------------------------ storage (may throw) */
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

/* ------------------------------------------------------------------ dates & formatting */
const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (s) => { const [y, m, d] = s.slice(0, 10).split("-").map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
const daysBetween = (a, b) => Math.round((parse(b) - parse(a)) / 86400000);
const weekStart = (s) => { const d = parse(s); const wd = (d.getDay() + 6) % 7; d.setDate(d.getDate() - wd); return iso(d); };
const TODAY = iso(new Date());
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const fmtDay = (s) => { const d = parse(s); return `${d.getDate()} ${MONTHS[d.getMonth()]}`; };
const fmtDayLong = (s) => { const d = parse(s); return `${["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`; };

function fmtHM(sec) {
  if (sec == null) return "–";
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}:${pad(m % 60)} h`;
}
const fmtH = (h) => (h == null ? "–" : h.toFixed(1));
function fmtClock(sec) {
  if (sec == null || !isFinite(sec)) return "–";
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
function fmtDist(m, sport) {
  if (m == null || !m) return "–";
  if (sport === "swim") return `${Math.round(m).toLocaleString()} m`;
  return `${(m / 1000).toFixed(m >= 100000 ? 0 : 1)} km`;
}
const paceRun = (mps) => (mps ? 1000 / mps : null);  // sec per km
const paceSwim = (mps) => (mps ? 100 / mps : null);  // sec per 100 m
function intensityText(a) {
  if (a.sport === "run" && a.avg_speed) return `${fmtClock(paceRun(a.avg_speed))} /km`;
  if (a.sport === "swim" && a.avg_speed) return `${fmtClock(paceSwim(a.avg_speed))} /100m`;
  if (a.sport === "bike") {
    if (a.np || a.avg_power) return `${Math.round(a.np || a.avg_power)} W${a.np ? " NP" : ""}`;
    if (a.avg_speed) return `${(a.avg_speed * 3.6).toFixed(1)} km/h`;
  }
  return "–";
}
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* ------------------------------------------------------------------ crypto */
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function decryptEnvelope(env, password) {
  const km = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: b64(env.salt), iterations: env.iter, hash: "SHA-256" },
    km, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64(env.iv) }, key, b64(env.ct));
  let text;
  if (env.gzip) {
    const stream = new Blob([pt]).stream().pipeThrough(new DecompressionStream("gzip"));
    text = await new Response(stream).text();
  } else text = new TextDecoder().decode(pt);
  return JSON.parse(text);
}

/* ------------------------------------------------------------------ boot */
async function getJSON(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(r.status);
  return r.json();
}

async function boot() {
  const saved = store.get("tri-theme");
  if (saved) document.documentElement.dataset.theme = saved;
  try { CONFIG = await getJSON("config.json"); } catch { CONFIG = {}; }
  document.title = CONFIG.title || document.title;

  let env = null;
  try { env = await getJSON("data/data.enc.json"); } catch {}
  if (env) {
    const remembered = store.get(PW_KEY);
    if (remembered) {
      try { return start(await decryptEnvelope(env, remembered), true); } catch { store.del(PW_KEY); }
    }
    return showLock(env);
  }
  try { return start(await getJSON("data/data.json"), false); } catch {}
  document.getElementById("empty").hidden = false;
}

function showLock(env) {
  const lock = document.getElementById("lock");
  lock.hidden = false;
  document.getElementById("pw").focus();
  document.getElementById("lock-form").onsubmit = async (e) => {
    e.preventDefault();
    const pw = document.getElementById("pw").value;
    const err = document.getElementById("lock-err");
    err.textContent = "Decrypting…";
    try {
      const data = await decryptEnvelope(env, pw);
      if (document.getElementById("remember").checked) store.set(PW_KEY, pw);
      lock.hidden = true;
      err.textContent = "";
      start(data, true);
    } catch {
      err.textContent = "Wrong password.";
    }
  };
}

function start(data, encrypted) {
  DATA = data;
  M = buildModel(data);
  document.getElementById("app").hidden = false;
  document.getElementById("title").textContent = CONFIG.title || "Triathlon Training";
  if (data.generated) {
    const g = new Date(data.generated);
    document.getElementById("synced").textContent =
      `Last sync ${g.toLocaleDateString(undefined, { day: "numeric", month: "short" })}, ` +
      `${g.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })} · ${data.activities.length} activities`;
  }
  const lockBtn = document.getElementById("lock-btn");
  lockBtn.hidden = !encrypted;
  lockBtn.onclick = () => { store.del(PW_KEY); location.reload(); };
  document.getElementById("theme").onclick = () => {
    const root = document.documentElement;
    const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    root.dataset.theme = dark ? "light" : "dark";
    store.set("tri-theme", root.dataset.theme);
  };
  segmented("pmc-range", "d", (v) => { state.pmcDays = +v; renderPMC(); });
  segmented("vol-metric", "m", (v) => { state.volMetric = v; renderVolume(); });
  renderAll();
  let t;
  window.addEventListener("resize", () => { clearTimeout(t); t = setTimeout(renderCharts, 120); });
}

function segmented(id, attr, cb) {
  const el = document.getElementById(id);
  el.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
    el.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    cb(b.dataset[attr]);
  }));
}

/* ------------------------------------------------------------------ model */
function actLoad(a) {
  if (a.load != null) return a.load;
  if (a.tss != null) return a.tss;
  const h = (a.dur_s || 0) / 3600;
  return h * (a.sport === "other" ? 30 : 55); // rough fallback when Garmin gives no load
}

function buildModel(data) {
  const acts = (data.activities || []).map((a) => ({ ...a, sport: a.sport === "multi" ? "other" : a.sport, L: actLoad(a) }));
  const health = data.health || {};

  // daily load → CTL / ATL / TSB
  const daily = {};
  acts.forEach((a) => { daily[a.date] = (daily[a.date] || 0) + a.L; });
  const first = acts.length ? acts[0].date : addDays(TODAY, -180);
  const pmc = [];
  let ctl = 0, atl = 0;
  for (let d = first; d <= TODAY; d = addDays(d, 1)) {
    const tsb = ctl - atl; // form uses yesterday's values
    const l = daily[d] || 0;
    ctl += (l - ctl) / 42;
    atl += (l - atl) / 7;
    pmc.push({ date: d, load: l, ctl, atl, tsb });
  }

  // weekly buckets (Monday start), last 16 weeks incl. current
  const thisWeek = weekStart(TODAY);
  const weeks = [];
  for (let i = 15; i >= 0; i--) weeks.push(addDays(thisWeek, -7 * i));
  const wk = Object.fromEntries(weeks.map((w) => [w, emptyWeek()]));
  acts.forEach((a) => {
    const w = wk[weekStart(a.date)];
    if (!w) return;
    const s = w[a.sport] || w.other;
    s.h += (a.dur_s || 0) / 3600; s.dist += a.dist_m || 0; s.n += 1; s.load += a.L;
    if (a.avg_speed && a.dur_s && a.dist_m) { s.speedT += a.dur_s; s.speedD += a.dist_m; }
    const p = a.np || a.avg_power;
    if (p && a.dur_s) { s.powT += a.dur_s; s.powW += p * a.dur_s; }
  });

  return { acts, health, pmc, weeks, wk, thisWeek };
}
function emptyWeek() {
  const o = {};
  SPORTS.forEach((s) => (o[s.key] = { h: 0, dist: 0, n: 0, load: 0, speedT: 0, speedD: 0, powT: 0, powW: 0 }));
  return o;
}

/* ------------------------------------------------------------------ render */
function renderAll() {
  renderKPIs();
  renderSports();
  renderZones();
  renderRaces();
  renderRecent();
  renderCharts();
}
function renderCharts() {
  renderPMC();
  renderVolume();
  renderSparks();
  renderRecovery();
}

function kpi(label, value, sub, pill) {
  return `<div class="kpi"><div class="label">${label}</div><div class="value">${value}</div>` +
    `<div class="sub">${pill ? `<span class="pill ${pill[0]}">${pill[1]}</span> ` : ""}${sub || ""}</div></div>`;
}

function formStatus(tsb) {
  if (tsb > 15) return ["neutral", "◇ Very fresh", "detraining if it lasts"];
  if (tsb > 5) return ["good", "● Fresh", "good for racing"];
  if (tsb > -10) return ["neutral", "◆ Neutral", "maintaining"];
  if (tsb > -30) return ["good", "▲ Productive", "building fitness"];
  return ["bad", "▼ High fatigue", "plan recovery"];
}

function lastHealth(key, maxAge = 3) {
  const days = Object.keys(M.health).sort().reverse();
  for (const d of days) {
    if (daysBetween(d, TODAY) > maxAge) break;
    if (M.health[d][key] != null) return { date: d, v: M.health[d][key], rec: M.health[d] };
  }
  return null;
}
function avgHealth(key, n, endOffset = 0) {
  const vals = [];
  for (let i = endOffset; i < n + endOffset; i++) {
    const r = M.health[addDays(TODAY, -i)];
    if (r && r[key] != null) vals.push(r[key]);
  }
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

function renderKPIs() {
  const p = M.pmc[M.pmc.length - 1] || { ctl: 0, atl: 0, tsb: 0 };
  const p7 = M.pmc[M.pmc.length - 8] || p;
  const fs = formStatus(p.tsb);
  const dCtl = p.ctl - p7.ctl;
  const w = M.wk[M.thisWeek];
  const hrsWeek = SPORTS.reduce((s, x) => s + w[x.key].h, 0);
  const targets = CONFIG.weekly_targets_hours || {};
  const tgt = ["swim", "bike", "run"].reduce((s, k) => s + (targets[k] || 0), 0);

  const hrv = lastHealth("hrv");
  let hrvPill = null, hrvSub = "no data";
  if (hrv) {
    const st = (hrv.rec.hrv_status || "").toUpperCase();
    hrvPill = st === "BALANCED" ? ["good", "● Balanced"] : st === "UNBALANCED" ? ["warn", "▲ Unbalanced"]
      : st === "LOW" || st === "POOR" ? ["bad", "▼ " + st[0] + st.slice(1).toLowerCase()] : null;
    hrvSub = hrv.rec.hrv_week ? `7-day avg ${Math.round(hrv.rec.hrv_week)}` : "";
  }
  const rhr = lastHealth("rhr");
  const rhrBase = avgHealth("rhr", 28, 1);
  let rhrPill = null;
  if (rhr && rhrBase) {
    const d = rhr.v - rhrBase;
    rhrPill = d >= 5 ? ["bad", `▲ +${d.toFixed(0)}`] : d >= 3 ? ["warn", `▲ +${d.toFixed(0)}`] : ["good", `● ${d >= 0 ? "+" : ""}${d.toFixed(0)}`];
  }
  const race = nextRaces()[0];

  document.getElementById("kpis").innerHTML = [
    kpi("Form (TSB)", `${p.tsb >= 0 ? "+" : ""}${p.tsb.toFixed(0)}`, fs[2], [fs[0], fs[1]]),
    kpi("Fitness (CTL)", p.ctl.toFixed(0), "vs 7 days ago",
      [dCtl >= 0 ? "good" : "neutral", `${dCtl >= 0 ? "▲ +" : "▼ "}${dCtl.toFixed(1)}`]),
    kpi("This week", `${fmtH(hrsWeek)}<small>h</small>`, tgt ? `of ${tgt} h target · ${Math.round((hrsWeek / tgt) * 100)}%` : "training time"),
    kpi("HRV last night", hrv ? `${Math.round(hrv.v)}<small>ms</small>` : "–", hrvSub, hrvPill),
    kpi("Resting HR", rhr ? `${Math.round(rhr.v)}<small>bpm</small>` : "–", rhrBase ? `vs 4-wk avg ${rhrBase.toFixed(0)}` : "", rhrPill),
    race ? kpi("Next race", `${race.days}<small>days</small>`, esc(race.name)) : kpi("Next race", "–", "add races in config.json"),
  ].join("");
}

/* ---------- PMC */
function renderPMC() {
  const el = document.getElementById("pmc");
  const rows = M.pmc.slice(-state.pmcDays);
  if (!rows.length) return (el.innerHTML = `<div class="nodata">No activities yet</div>`);
  lineChart(el, {
    dates: rows.map((r) => r.date),
    series: [
      { name: "Fitness", color: "var(--fitness)", values: rows.map((r) => r.ctl) },
      { name: "Fatigue", color: "var(--fatigue)", values: rows.map((r) => r.atl) },
      { name: "Form", color: "var(--form)", values: rows.map((r) => r.tsb), dash: "4 3" },
    ],
    zero: true,
    yFmt: (v) => v.toFixed(0),
    endLabels: true,
    extraTip: (i) => [["Load that day", rows[i].load ? rows[i].load.toFixed(0) : "rest"]],
  });
}

/* ---------- weekly volume */
function renderVolume() {
  const el = document.getElementById("volume");
  const metric = state.volMetric;
  const keys = SPORTS;
  const rows = M.weeks.map((w) => {
    const o = { label: w };
    keys.forEach((k) => (o[k.key] = metric === "hours" ? M.wk[w][k.key].h : M.wk[w][k.key].load));
    return o;
  });
  const targets = CONFIG.weekly_targets_hours || {};
  const tgt = ["swim", "bike", "run"].reduce((s, k) => s + (targets[k] || 0), 0);
  const last4 = M.weeks.slice(-5, -1).map((w) => SPORTS.reduce((s, k) => s + M.wk[w][k.key].h, 0));
  const avg4 = last4.reduce((a, b) => a + b, 0) / (last4.length || 1);
  document.getElementById("vol-sub").textContent =
    `Last 16 weeks · 4-week average ${avg4.toFixed(1)} h${tgt ? ` · dashed line = ${tgt} h target` : ""}`;
  stackedBars(el, {
    labels: rows.map((r) => r.label),
    keys,
    rows,
    yFmt: metric === "hours" ? (v) => `${v.toFixed(v < 10 && v % 1 ? 1 : 0)}` : (v) => v.toFixed(0),
    unit: metric === "hours" ? "h" : "",
    target: metric === "hours" ? tgt : null,
    xFmt: (s) => fmtDay(s),
    tipTitle: (s) => `Week of ${fmtDay(s)}${s === M.thisWeek ? " (current)" : ""}`,
    highlightLast: true,
  });
}

/* ---------- sport cards */
function renderSports() {
  const targets = CONFIG.weekly_targets_hours || {};
  const html = ["swim", "bike", "run"].map((k) => {
    const s = SPORT[k];
    const w = M.wk[M.thisWeek][k];
    const prev = M.weeks.slice(-5, -1).map((x) => M.wk[x][k]);
    const avgH = prev.reduce((a, b) => a + b.h, 0) / 4;
    const avgD = prev.reduce((a, b) => a + b.dist, 0) / 4;
    const t = targets[k];
    const pct = t ? Math.min(100, (w.h / t) * 100) : 0;
    const sparkTitle = k === "run" ? "Avg pace per week · higher = faster" : k === "swim" ? "Avg pace /100m per week · higher = faster"
      : hasPower() ? "Avg power per week (W)" : "Avg speed per week (km/h)";
    return `<div class="card sport">
      <h2><span class="dot" style="background:${s.color}"></span>${s.name}</h2>
      <div class="stats">
        <div><div class="v">${fmtHM(w.h * 3600)}</div><div class="k">this week</div></div>
        <div><div class="v">${fmtDist(w.dist, k)}</div><div class="k">distance</div></div>
        <div><div class="v">${w.n}</div><div class="k">sessions</div></div>
      </div>
      ${t ? `<div class="target"><div class="t"><span>Target ${t} h</span><span>${Math.round((w.h / t) * 100)}%</span></div>
        <div class="bar"><span style="width:${pct}%;background:${s.color}"></span></div></div>` : ""}
      <p class="muted">4-week avg: ${avgH.toFixed(1)} h · ${fmtDist(avgD, k)} per week</p>
      <p class="muted" style="margin-top:10px">${sparkTitle}</p>
      <div class="chart spark" id="spark-${k}"></div>
    </div>`;
  });
  document.getElementById("sports").innerHTML = html.join("");
}
function hasPower() { return M.acts.some((a) => a.sport === "bike" && (a.np || a.avg_power)); }

function renderSparks() {
  const weeks = M.weeks.slice(-12);
  ["swim", "bike", "run"].forEach((k) => {
    const el = document.getElementById(`spark-${k}`);
    if (!el) return;
    let vals, fmt, invert = false;
    if (k === "run") {
      vals = weeks.map((w) => { const s = M.wk[w].run; return s.speedD ? s.speedT / (s.speedD / 1000) : null; });
      fmt = (v) => fmtClock(v); invert = true;
    } else if (k === "swim") {
      vals = weeks.map((w) => { const s = M.wk[w].swim; return s.speedD ? s.speedT / (s.speedD / 100) : null; });
      fmt = (v) => fmtClock(v); invert = true;
    } else if (hasPower()) {
      vals = weeks.map((w) => { const s = M.wk[w].bike; return s.powT ? s.powW / s.powT : null; });
      fmt = (v) => `${Math.round(v)} W`;
    } else {
      vals = weeks.map((w) => { const s = M.wk[w].bike; return s.speedT ? (s.speedD / s.speedT) * 3.6 : null; });
      fmt = (v) => `${v.toFixed(1)} km/h`;
    }
    if (vals.every((v) => v == null)) { el.innerHTML = `<div class="nodata">No ${k} data in the last 12 weeks</div>`; return; }
    lineChart(el, {
      dates: weeks, series: [{ name: SPORT[k].name, color: SPORT[k].color, values: vals, dots: true }],
      yFmt: fmt, invert, compact: true, tipTitle: (d) => `Week of ${fmtDay(d)}`, xFmt: fmtDay,
    });
  });
}

/* ---------- zones */
function renderZones() {
  const since = addDays(TODAY, -27);
  const names = CONFIG.heart_rate_zone_names || ["Z1", "Z2", "Z3", "Z4", "Z5"];
  const sums = { swim: [0, 0, 0, 0, 0], bike: [0, 0, 0, 0, 0], run: [0, 0, 0, 0, 0], all: [0, 0, 0, 0, 0] };
  M.acts.filter((a) => a.date >= since && a.zones).forEach((a) => {
    a.zones.forEach((z, i) => { if (sums[a.sport]) sums[a.sport][i] += z; sums.all[i] += z; });
  });
  const legend = `<div class="legend">${names.map((n, i) => `<span><i style="background:${ZONE_COLORS[i]}"></i>${esc(n)}</span>`).join("")}</div>`;
  const rows = [["swim", "Swim"], ["bike", "Bike"], ["run", "Run"], ["all", "All"]].map(([k, label]) => {
    const tot = sums[k].reduce((a, b) => a + b, 0);
    if (!tot) return `<div class="zrow"><div class="name">${label}</div><div class="muted">no HR zone data</div><div></div></div>`;
    const segs = sums[k].map((z, i) => z ? `<span data-tip="${esc(label)}|${esc(names[i])}|${fmtHM(z)}|${Math.round((z / tot) * 100)}%" style="flex:${z} 0 0;background:${ZONE_COLORS[i]}"></span>` : "").join("");
    const easy = Math.round(((sums[k][0] + sums[k][1]) / tot) * 100);
    const cls = k === "all" ? (easy >= 75 ? "good" : easy >= 60 ? "warn" : "bad") : "neutral";
    return `<div class="zrow"><div class="name">${label}</div><div class="zbar">${segs}</div>
      <div class="easy"><span class="pill ${cls}">${easy}%</span> easy</div></div>`;
  });
  const el = document.getElementById("zones");
  el.innerHTML = legend + rows.join("") +
    `<p class="muted" style="margin-top:8px">“Easy” = Z1 + Z2. Endurance plans usually aim for roughly 75–80% easy.</p>`;
  el.querySelectorAll("[data-tip]").forEach((s) => {
    s.addEventListener("mousemove", (e) => {
      const [sp, z, t, p] = s.dataset.tip.split("|");
      showTip(e.clientX, e.clientY, `<b>${sp} · ${z}</b><div class="row"><span>Time</span><span>${t}</span></div><div class="row"><span>Share</span><span>${p}</span></div>`);
    });
    s.addEventListener("mouseleave", hideTip);
  });
}

/* ---------- races */
function nextRaces() {
  return (CONFIG.races || []).filter((r) => r.date >= TODAY).sort((a, b) => (a.date < b.date ? -1 : 1))
    .map((r) => ({ ...r, days: daysBetween(TODAY, r.date) }));
}
function renderRaces() {
  const races = nextRaces();
  document.getElementById("races").innerHTML = races.length ? races.map((r) => `
    <div class="race"><div><div>${r.priority ? `<span class="prio">${esc(r.priority)}</span>` : ""}<b>${esc(r.name)}</b></div>
      <div class="muted">${fmtDayLong(r.date)} ${parse(r.date).getFullYear()}</div></div>
      <div class="d">${r.days}<small>days · ${(r.days / 7).toFixed(0)} weeks</small></div></div>`).join("")
    : `<div class="nodata">No upcoming races in config.json</div>`;
  const p = DATA.race_predictions;
  document.getElementById("preds").innerHTML = p ? `<div class="preds">${[["time5K", "5K"], ["time10K", "10K"], ["timeHalfMarathon", "Half"], ["timeMarathon", "Marathon"]]
    .filter(([k]) => p[k]).map(([k, n]) => `<div><div class="v">${fmtClock(p[k])}</div><div class="k">${n} prediction</div></div>`).join("")}</div>` : "";
}

/* ---------- recovery */
function renderRecovery() {
  const days60 = []; for (let i = 59; i >= 0; i--) days60.push(addDays(TODAY, -i));
  const h = (d, k) => (M.health[d] ? M.health[d][k] ?? null : null);

  const hrvEl = document.getElementById("hrv");
  if (days60.some((d) => h(d, "hrv") != null)) {
    lineChart(hrvEl, {
      dates: days60, series: [{ name: "HRV", color: "var(--accent)", values: days60.map((d) => h(d, "hrv")), dots: true }],
      band: { lo: days60.map((d) => h(d, "hrv_low")), hi: days60.map((d) => h(d, "hrv_high")), name: "Baseline" },
      yFmt: (v) => `${Math.round(v)}`, compact: true, xFmt: fmtDay,
      extraTip: (i) => [["7-day avg", h(days60[i], "hrv_week") ?? "–"], ["Status", (h(days60[i], "hrv_status") || "–").toLowerCase()]],
    });
  } else hrvEl.innerHTML = `<div class="nodata">No HRV data (needs a watch with HRV status)</div>`;

  const rhrEl = document.getElementById("rhr");
  if (days60.some((d) => h(d, "rhr") != null)) {
    lineChart(rhrEl, {
      dates: days60, series: [{ name: "Resting HR", color: "var(--bad)", values: days60.map((d) => h(d, "rhr")), dots: true }],
      yFmt: (v) => `${Math.round(v)}`, compact: true, xFmt: fmtDay,
      extraTip: (i) => [["Body Battery high", h(days60[i], "bb_high") ?? "–"], ["Avg stress", h(days60[i], "stress") ?? "–"]],
    });
  } else rhrEl.innerHTML = `<div class="nodata">No resting HR data</div>`;

  const days30 = days60.slice(-30);
  const sleepEl = document.getElementById("sleep");
  if (days30.some((d) => h(d, "sleep_h") != null)) {
    stackedBars(sleepEl, {
      labels: days30, keys: [{ key: "sleep", name: "Sleep", color: "var(--fitness)" }],
      rows: days30.map((d) => ({ label: d, sleep: h(d, "sleep_h") || 0 })),
      yFmt: (v) => `${v.toFixed(v % 1 ? 1 : 0)}`, unit: "h", target: 8, compact: true, xFmt: fmtDay,
      tipTitle: (d) => fmtDayLong(d),
      extraTip: (i) => [["Sleep score", h(days30[i], "sleep_score") ?? "–"], ["HRV", h(days30[i], "hrv") ?? "–"]],
    });
  } else sleepEl.innerHTML = `<div class="nodata">No sleep data</div>`;
}

/* ---------- recent table */
function renderRecent() {
  const rows = M.acts.slice(-15).reverse();
  const tbl = document.getElementById("recent");
  tbl.innerHTML = `<thead><tr><th>Date</th><th>Session</th><th class="num">Time</th><th class="num">Distance</th>
    <th class="num">Pace / power</th><th class="num">Avg HR</th><th class="num">Load</th><th class="num">Aerobic TE</th></tr></thead><tbody>` +
    rows.map((a) => `<tr><td>${fmtDayLong(a.date)}</td>
      <td><span class="dot" style="background:${(SPORT[a.sport] || SPORT.other).color}"></span>${esc(a.name)}</td>
      <td class="num">${fmtHM(a.dur_s)}</td><td class="num">${fmtDist(a.dist_m, a.sport)}</td>
      <td class="num">${intensityText(a)}</td><td class="num">${a.avg_hr ? Math.round(a.avg_hr) : "–"}</td>
      <td class="num">${a.L ? Math.round(a.L) : "–"}</td><td class="num">${a.te_aer ?? "–"}</td></tr>`).join("") + "</tbody>";
}

/* ================================================================== tiny SVG chart kit */
const NS = "http://www.w3.org/2000/svg";
function S(tag, attrs = {}, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}
function niceTicks(lo, hi, n = 4) {
  if (lo === hi) { lo -= 1; hi += 1; }
  const span = hi - lo, raw = span / n, mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n) || 10 * mag;
  const t0 = Math.floor(lo / step) * step, t1 = Math.ceil(hi / step) * step;
  const out = []; for (let v = t0; v <= t1 + step / 2; v += step) out.push(+v.toFixed(6));
  return out;
}
function showTip(x, y, html) {
  const tip = document.getElementById("tip");
  tip.innerHTML = html; tip.hidden = false;
  const r = tip.getBoundingClientRect();
  let left = x + 14, top = y + 14;
  if (left + r.width > innerWidth - 8) left = x - r.width - 14;
  if (top + r.height > innerHeight - 8) top = y - r.height - 14;
  tip.style.left = `${left}px`; tip.style.top = `${top}px`;
}
function hideTip() { document.getElementById("tip").hidden = true; }
const tipRow = (label, val, color) => `<div class="row"><span>${color ? `<i class="sw" style="background:${color}"></i>` : ""}${label}</span><span>${val}</span></div>`;

function xTickIdx(n, width, minGap = 70) {
  const count = Math.max(2, Math.min(n, Math.floor(width / minGap)));
  const out = []; for (let i = 0; i < count; i++) out.push(Math.round((i * (n - 1)) / (count - 1)));
  return [...new Set(out)];
}

function lineChart(el, o) {
  el.innerHTML = "";
  const multi = o.series.length > 1;
  if (multi && !o.compact) {
    const lg = document.createElement("div"); lg.className = "legend";
    lg.innerHTML = o.series.map((s) => `<span><i class="line" style="background:${s.color}"></i>${s.name}</span>`).join("") +
      (o.band ? `<span><i style="background:var(--band)"></i>${o.band.name}</span>` : "");
    el.appendChild(lg);
  }
  const W = el.clientWidth, H = el.clientHeight - (el.firstChild ? el.firstChild.offsetHeight + 6 : 0);
  const m = { l: 40, r: o.endLabels ? 64 : 10, t: 8, b: 22 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b, n = o.dates.length;
  const all = o.series.flatMap((s) => s.values).concat(o.band ? [...o.band.lo, ...o.band.hi] : []).filter((v) => v != null && isFinite(v));
  if (o.zero) all.push(0);
  let lo = Math.min(...all), hi = Math.max(...all);
  const padv = (hi - lo) * 0.08 || 1; lo -= padv; hi += padv;
  const ticks = niceTicks(lo, hi, o.compact ? 3 : 4);
  lo = Math.min(lo, ticks[0]); hi = Math.max(hi, ticks[ticks.length - 1]);
  const x = (i) => m.l + (n === 1 ? iw / 2 : (i * iw) / (n - 1));
  const y = (v) => (o.invert ? m.t + ((v - lo) / (hi - lo)) * ih : m.t + ih - ((v - lo) / (hi - lo)) * ih);

  const svg = S("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": o.series.map((s) => s.name).join(", ") }, el);
  const g = S("g", { class: "grid" }, svg);
  ticks.forEach((t) => {
    if (t < lo || t > hi) return;
    S("line", { x1: m.l, x2: m.l + iw, y1: y(t), y2: y(t) }, g);
    S("text", { x: m.l - 6, y: y(t) + 3.5, "text-anchor": "end" }, svg).textContent = o.yFmt(t);
  });
  if (o.zero && lo < 0 && hi > 0) S("line", { class: "base", x1: m.l, x2: m.l + iw, y1: y(0), y2: y(0) }, svg);
  const xf = o.xFmt || fmtDay;
  xTickIdx(n, iw).forEach((i) => {
    S("text", { x: x(i), y: H - 6, "text-anchor": i === 0 ? "start" : i === n - 1 ? "end" : "middle" }, svg).textContent = xf(o.dates[i]);
  });

  if (o.band) {
    const pts = [];
    o.band.hi.forEach((v, i) => { if (v != null && o.band.lo[i] != null) pts.push(i); });
    if (pts.length > 1) {
      const d = pts.map((i, k) => `${k ? "L" : "M"}${x(i)},${y(o.band.hi[i])}`).join("") +
        pts.slice().reverse().map((i) => `L${x(i)},${y(o.band.lo[i])}`).join("") + "Z";
      S("path", { d, style: "fill:var(--band)" }, svg);
    }
  }
  const labels = [];
  o.series.forEach((s) => {
    const idx = s.values.map((v, i) => (v != null ? i : -1)).filter((i) => i >= 0);
    if (!idx.length) return;
    const d = idx.map((i, k) => `${k ? "L" : "M"}${x(i).toFixed(1)},${y(s.values[i]).toFixed(1)}`).join("");
    S("path", { d, style: `fill:none;stroke:${s.color};stroke-width:2;stroke-linejoin:round;stroke-linecap:round${s.dash ? `;stroke-dasharray:${s.dash}` : ""}` }, svg);
    if (s.dots && idx.length <= 70) idx.forEach((i) => S("circle", { cx: x(i), cy: y(s.values[i]), r: n > 30 ? 2 : 3, style: `fill:${s.color}` }, svg));
    const li = idx[idx.length - 1];
    labels.push({ s, y: y(s.values[li]), x: x(li), v: s.values[li] });
  });
  if (o.endLabels) {
    labels.sort((a, b) => a.y - b.y);
    for (let i = 1; i < labels.length; i++) if (labels[i].y - labels[i - 1].y < 14) labels[i].y = labels[i - 1].y + 14;
    labels.forEach((L) => {
      const t = S("text", { x: m.l + iw + 8, y: L.y + 4, class: "lbl", style: "fill:var(--text-secondary)" }, svg);
      t.textContent = `${L.s.name} ${o.yFmt(L.v)}`;
    });
  }

  // hover layer
  const hover = S("g", { style: "display:none" }, svg);
  const xl = S("line", { class: "xhair", y1: m.t, y2: m.t + ih }, hover);
  const dots = o.series.map((s) => S("circle", { r: 4, style: `fill:${s.color};stroke:var(--surface-1);stroke-width:2` }, hover));
  const hit = S("rect", { x: m.l, y: 0, width: iw, height: H, style: "fill:transparent" }, svg);
  hit.addEventListener("mousemove", (e) => {
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(n - 1, Math.round(((px - m.l) / iw) * (n - 1))));
    hover.style.display = "";
    xl.setAttribute("x1", x(i)); xl.setAttribute("x2", x(i));
    o.series.forEach((s, k) => {
      const v = s.values[i];
      dots[k].style.display = v == null ? "none" : "";
      if (v != null) { dots[k].setAttribute("cx", x(i)); dots[k].setAttribute("cy", y(v)); }
    });
    const title = o.tipTitle ? o.tipTitle(o.dates[i]) : fmtDayLong(o.dates[i]);
    let html = `<b>${title}</b>` + o.series.map((s) => tipRow(s.name, s.values[i] == null ? "–" : o.yFmt(s.values[i]), s.color)).join("");
    if (o.band && o.band.lo[i] != null) html += tipRow(o.band.name, `${o.yFmt(o.band.lo[i])}–${o.yFmt(o.band.hi[i])}`);
    if (o.extraTip) html += o.extraTip(i).map(([k, v]) => tipRow(k, v)).join("");
    showTip(e.clientX, e.clientY, html);
  });
  hit.addEventListener("mouseleave", () => { hover.style.display = "none"; hideTip(); });
}

function topRounded(x, y, w, h, r) {
  r = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function stackedBars(el, o) {
  el.innerHTML = "";
  const keys = o.keys;
  if (keys.length > 1 && !o.compact) {
    const lg = document.createElement("div"); lg.className = "legend";
    lg.innerHTML = keys.map((k) => `<span><i style="background:${k.color}"></i>${k.name}</span>`).join("") +
      (o.target ? `<span><i class="line" style="background:var(--text-secondary)"></i>Target</span>` : "");
    el.appendChild(lg);
  }
  const W = el.clientWidth, H = el.clientHeight - (el.firstChild ? el.firstChild.offsetHeight + 6 : 0);
  const m = { l: 40, r: 10, t: 8, b: 22 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b, n = o.rows.length;
  const totals = o.rows.map((r) => keys.reduce((s, k) => s + (r[k.key] || 0), 0));
  const ticks = niceTicks(0, Math.max(...totals, o.target || 0, 1) * 1.05, o.compact ? 3 : 4);
  const hi = ticks[ticks.length - 1];
  const y = (v) => m.t + ih - (v / hi) * ih;
  const band = iw / n, bw = Math.max(2, Math.min(42, band * 0.68));

  const svg = S("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": keys.map((k) => k.name).join(", ") }, el);
  const g = S("g", { class: "grid" }, svg);
  ticks.forEach((t) => {
    S("line", { x1: m.l, x2: m.l + iw, y1: y(t), y2: y(t) }, g);
    S("text", { x: m.l - 6, y: y(t) + 3.5, "text-anchor": "end" }, svg).textContent = o.yFmt(t) + (t && o.unit ? o.unit : "");
  });
  const xf = o.xFmt || ((s) => s);
  xTickIdx(n, iw, o.compact ? 60 : 58).forEach((i) => {
    S("text", { x: m.l + band * i + band / 2, y: H - 6, "text-anchor": "middle" }, svg).textContent = xf(o.labels[i]);
  });

  const hl = S("rect", { y: m.t, height: ih, width: band, rx: 6, style: "fill:var(--grid);opacity:.5;display:none" }, svg);
  svg.insertBefore(hl, g.nextSibling);

  o.rows.forEach((r, i) => {
    const x0 = m.l + band * i + (band - bw) / 2;
    let acc = 0;
    const present = keys.filter((k) => r[k.key] > 0);
    present.forEach((k, j) => {
      const v = r[k.key];
      const yTop = y(acc + v), yBot = y(acc);
      const gap = j > 0 ? 2 : 0; // 2px surface gap between stacked segments
      const h = Math.max(0, yBot - yTop - gap);
      const isTop = j === present.length - 1;
      const op = o.highlightLast && i === n - 1 ? "0.55" : "1";
      if (isTop) S("path", { d: topRounded(x0, yTop, bw, h, 4), style: `fill:${k.color};opacity:${op}` }, svg);
      else S("rect", { x: x0, y: yTop, width: bw, height: h, style: `fill:${k.color};opacity:${op}` }, svg);
      acc += v;
    });
  });
  S("line", { class: "base", x1: m.l, x2: m.l + iw, y1: y(0), y2: y(0) }, svg);
  if (o.target) {
    S("line", { x1: m.l, x2: m.l + iw, y1: y(o.target), y2: y(o.target), style: "stroke:var(--text-secondary);stroke-width:1.5;stroke-dasharray:5 4" }, svg);
  }

  const hit = S("rect", { x: m.l, y: 0, width: iw, height: H, style: "fill:transparent" }, svg);
  hit.addEventListener("mousemove", (e) => {
    const rc = svg.getBoundingClientRect();
    const px = ((e.clientX - rc.left) / rc.width) * W;
    const i = Math.max(0, Math.min(n - 1, Math.floor((px - m.l) / band)));
    hl.style.display = ""; hl.setAttribute("x", m.l + band * i);
    const r = o.rows[i];
    const fmtV = (v) => o.yFmt(v) + (o.unit ? ` ${o.unit}` : "");
    let html = `<b>${o.tipTitle ? o.tipTitle(o.labels[i]) : o.labels[i]}</b>` +
      keys.slice().reverse().map((k) => tipRow(k.name, fmtV(r[k.key] || 0), k.color)).join("");
    if (keys.length > 1) html += tipRow("Total", fmtV(totals[i]));
    if (o.extraTip) html += o.extraTip(i).map(([k, v]) => tipRow(k, v)).join("");
    showTip(e.clientX, e.clientY, html);
  });
  hit.addEventListener("mouseleave", () => { hl.style.display = "none"; hideTip(); });
}

boot();
