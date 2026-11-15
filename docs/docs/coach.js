/* Coach: your own plan (training-plan.json) + checks against your Garmin data.
 *
 * - Every planned session gets an estimated duration and training load, calibrated on
 *   YOUR history (your load per hour per sport, your easy run pace, bike speed, swim pace).
 * - Fitness (CTL), fatigue (ATL) and form (TSB) are projected day by day through the plan.
 * - Each week is checked: fitness ramp, load jump, too little, fatigue, running limits
 *   and increases (run rebuild!), hard-session count and spacing, intensity mix, rest days,
 *   recovery signals (HRV / resting HR) and how much of the plan you've actually done.
 * Thresholds are in COACH_RULES below. You can override any of them with "coach" in config.json.
 */
"use strict";

let TP = null; // training-plan.json
const COACH_RULES = {
  ramp_red: 8, ramp_amber: 6,            // fitness (CTL) gain per week
  jump_red: 0.35, jump_amber: 0.2,       // load vs average of previous 4 weeks
  too_little: 0.75,                      // below 75% of previous 4 weeks (non-recovery week)
  recovery_max: 0.85,                    // a recovery week should be below 85%
  form_red: -35, form_amber: -25,        // lowest projected form (TSB) in the week
  run_increase: 0.15, long_run_increase: 0.2,
  max_hard: 3, easy_share: 0.7,
};
const rules = () => ({ ...COACH_RULES, ...(CONFIG.coach || {}) });
const INTENSITY_MULT = { recovery: 0.4, easy: 0.85, moderate: 1.1, hard: 1.35, very_hard: 1.5, strength: 1, race: 1.4 };
const HARD = new Set(["hard", "very_hard", "race"]);
const RECOVERY_RE = /regener|erhol|entlast|recover|taper|race|wettkampf|rennen|feiertag|leicht|deload|rest/i;
const DEFAULT_LPH = { swim: 55, bike: 60, run: 75, strength: 30, other: 40 };

/* ------------------------------------------------------------------ calibration from your data */
let CAL = null;
function median(a) { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function calibrate() {
  const since = addDays(TODAY, -84);
  const recent = M.acts.filter((a) => a.date >= since && (a.dur_s || 0) >= 1200);
  const lph = {};
  ["swim", "bike", "run", "strength", "other"].forEach((k) => {
    const v = recent.filter((a) => a.sport === k && a.load != null).map((a) => a.L / (a.dur_s / 3600));
    lph[k] = v.length >= 3 ? median(v) : DEFAULT_LPH[k];
  });
  const ath = CONFIG.athlete || {};
  const parsePace = (s) => { if (!s) return null; const [m, sec] = String(s).split(":").map(Number); return m * 60 + (sec || 0); };
  const easyRuns = recent.filter((a) => a.sport === "run" && a.avg_speed && (!a.avg_hr || a.avg_hr <= 150));
  const runPace = parsePace(ath.run_easy_pace) || median(easyRuns.map((a) => 1000 / a.avg_speed)) || 390;
  const rides = recent.filter((a) => a.sport === "bike" && a.avg_speed && !/virtual|indoor/.test(a.type || "") && a.dur_s >= 3600);
  const bikeKmh = ath.bike_z2_kmh || median(rides.map((a) => a.avg_speed * 3.6)) || 25;
  const swims = recent.filter((a) => a.sport === "swim" && a.avg_speed);
  const swimPace = parsePace(ath.swim_pace_100m) || median(swims.map((a) => 100 / a.avg_speed)) || 135;
  CAL = { lph, runPace, bikeKmh, swimPace };
}

/* ------------------------------------------------------------------ plan items → sessions */
function normalise(item) {
  const it = typeof item === "string" ? { w: item } : { ...item };
  const lib = (TP && TP.workouts && TP.workouts[it.w]) || {};
  const sport = it.sport || lib.sport || "other";
  const intensity = it.intensity || lib.intensity || "easy";
  let mins = it.min ?? (it.h != null ? it.h * 60 : null);
  let est = false;
  const km = it.km ?? null;
  if (mins == null && km != null) {
    est = true;
    if (sport === "run") mins = (km * CAL.runPace * (HARD.has(intensity) ? 0.9 : 1)) / 60;
    else if (sport === "bike") mins = (km / CAL.bikeKmh) * 60;
    else if (sport === "swim") mins = (km * 10 * CAL.swimPace) / 60;
  }
  if (mins == null) { mins = lib.min ?? 45; est = it.min == null; }
  const runKm = sport === "run" ? km ?? (mins * 60) / (CAL.runPace * (HARD.has(intensity) ? 0.9 : 1)) : 0;
  const load = (mins / 60) * (CAL.lph[sport] || 50) * (INTENSITY_MULT[intensity] || 1);
  return {
    id: it.w, sport, intensity, mins, est, km, runKm, load,
    name: it.name || lib.name || it.w || "Session",
    target: it.target ?? lib.target ?? "", note: it.note || "",
    hard: HARD.has(intensity) && sport !== "strength",
    long: /long/.test(it.w || "") || /long/i.test(lib.name || ""),
  };
}

// The plan for a week: yours if it's in training-plan.json, otherwise the automatic suggestion
function weekPlan(monday) {
  const wk = TP && TP.weeks && TP.weeks[monday];
  if (wk) {
    const days = PLAN_DAYS.map((d, i) => ({ date: addDays(monday, i), sessions: (wk.days[d] || []).map(normalise) }));
    return { monday, source: "yours", label: wk.label || "", phase: wk.phase || "", comment: wk.comment || "",
      runLimit: wk.run_limit_km, longLimit: wk.long_run_limit_km, days };
  }
  const auto = buildPlan(monday, monday === M.thisWeek, false);
  const days = auto.days.map((d) => ({
    date: d.date,
    sessions: d.sessions.map((s) => {
      const intensity = s.sport === "race" ? "race" : s.key && !s.long && s.role === "key" ? "hard" : s.sport === "strength" ? "strength" : "easy";
      const n = normalise({ w: `auto_${s.sport}`, sport: s.sport === "race" ? "other" : s.sport, min: s.mins || 180, intensity, name: s.title, target: s.detail });
      n.long = s.role === "long";
      return n;
    }),
  }));
  return { monday, source: "auto", label: auto.recovery ? "Recovery week" : auto.phase, phase: auto.phase,
    comment: PHASE_INFO[auto.phase].text, autoNotes: auto.notes, days };
}

/* ------------------------------------------------------------------ projection */
function actualsFor(date) { return M.acts.filter((a) => a.date === date); }
function weekActualLoad(monday) { let s = 0; for (let i = 0; i < 7; i++) actualsFor(addDays(monday, i)).forEach((a) => (s += a.L)); return s; }
function weekActualRun(monday) {
  const runs = M.acts.filter((a) => a.sport === "run" && a.date >= monday && a.date <= addDays(monday, 6));
  return { km: runs.reduce((s, a) => s + (a.dist_m || 0) / 1000, 0), longest: runs.reduce((m, a) => Math.max(m, (a.dist_m || 0) / 1000), 0) };
}

let COACH = null;
function buildCoach(nWeeks = 9) {
  calibrate();
  const R = rules();
  const weeks = [];
  for (let i = 0; i < nWeeks; i++) weeks.push(weekPlan(addDays(M.thisWeek, 7 * i)));

  // day-by-day projection, starting from yesterday's real values
  const pmcIdx = M.pmc.length - 2;
  let ctl = pmcIdx >= 0 ? M.pmc[pmcIdx].ctl : 0, atl = pmcIdx >= 0 ? M.pmc[pmcIdx].atl : 0;
  const proj = {};
  // past days of this week: real
  for (let i = 0; i < 7; i++) {
    const d = addDays(M.thisWeek, i);
    if (d >= TODAY) break;
    const p = M.pmc.find((x) => x.date === d);
    if (p) proj[d] = { ctl: p.ctl, atl: p.atl, tsb: p.tsb, load: p.load, real: true };
  }
  weeks.forEach((w) => w.days.forEach((day) => {
    if (day.date < TODAY) return;
    const real = actualsFor(day.date);
    const planned = day.sessions.reduce((s, x) => s + x.load, 0);
    const load = day.date === TODAY && real.length ? Math.max(real.reduce((s, a) => s + a.L, 0), 0) : planned;
    const tsb = ctl - atl;
    ctl += (load - ctl) / 42; atl += (load - atl) / 7;
    proj[day.date] = { ctl, atl, tsb, load, real: false };
  }));

  // series of weekly numbers: completed weeks = real, current = real so far + plan for the rest, future = plan
  const series = {};
  for (let i = 4; i >= 1; i--) {
    const m = addDays(M.thisWeek, -7 * i);
    const r = weekActualRun(m);
    series[m] = { load: weekActualLoad(m), runKm: r.km, longest: r.longest };
  }
  weeks.forEach((w) => {
    let load = 0, runKm = 0, longest = 0;
    w.days.forEach((d) => {
      if (d.date < TODAY || (d.date === TODAY && actualsFor(d.date).length)) {
        actualsFor(d.date).forEach((a) => { load += a.L; if (a.sport === "run") { runKm += (a.dist_m || 0) / 1000; longest = Math.max(longest, (a.dist_m || 0) / 1000); } });
      } else d.sessions.forEach((s) => { load += s.load; runKm += s.runKm; longest = Math.max(longest, s.runKm); });
    });
    series[w.monday] = { load, runKm, longest };
  });

  weeks.forEach((w, wi) => {
    const prev = [1, 2, 3, 4].map((i) => series[addDays(w.monday, -7 * i)]).filter(Boolean);
    const prevLoad = prev.length ? prev.reduce((s, x) => s + x.load, 0) / prev.length : 0;
    const prevRun = prev.length ? Math.max(...prev.map((x) => x.runKm)) : 0;
    const prevLong = prev.length ? Math.max(...prev.map((x) => x.longest)) : 0;
    const cur = series[w.monday];
    const start = proj[addDays(w.monday, -1)] || (M.pmc.find((x) => x.date === addDays(w.monday, -1))) || { ctl: 0 };
    const end = proj[addDays(w.monday, 6)] || start;
    const tsbs = w.days.map((d) => proj[d.date]).filter((p) => p && !p.real);
    const minForm = tsbs.length ? tsbs.reduce((m, p) => (p.tsb < m.tsb ? p : m), tsbs[0]) : null;
    const minFormDay = minForm ? w.days.find((d) => proj[d.date] === minForm).date : null;
    const all = w.days.flatMap((d) => d.sessions);
    const endurance = all.filter((s) => ["swim", "bike", "run"].includes(s.sport));
    const plannedH = all.reduce((s, x) => s + x.mins / 60, 0);
    const bySport = {};
    all.forEach((s) => (bySport[s.sport] = (bySport[s.sport] || 0) + s.mins / 60));
    const runKmPlan = all.reduce((s, x) => s + x.runKm, 0);
    const longPlan = all.reduce((m, x) => Math.max(m, x.runKm), 0);
    const ramp = end.ctl - start.ctl;
    const isRecovery = RECOVERY_RE.test(`${w.label} ${w.source === "auto" ? "" : ""}`) || w.label === "Recovery week";
    const isTaper = /taper|wettkampf|race/i.test(`${w.label} ${w.phase}`);
    const isCurrent = wi === 0;
    const msgs = [];
    const add = (level, text) => msgs.push({ level, text });
    const pct = (x) => `${x >= 0 ? "+" : ""}${Math.round(x * 100)}%`;
    const ratio = prevLoad ? cur.load / prevLoad : null;

    if (w.source === "auto") add("info", "No plan entered for this week, so this is an automatic suggestion. Add it to training-plan.json.");

    // running limits (rebuild)
    if (w.runLimit != null && cur.runKm > w.runLimit + 0.5)
      add("red", `Running ${cur.runKm.toFixed(1)} km${isCurrent ? " (done + planned)" : ""}: over your rebuild limit of ${w.runLimit} km${all.some((s) => s.sport === "run" && s.km == null) ? " (some runs are estimated from duration)" : ""}.`);
    const runEst = all.some((s) => s.sport === "run" && s.km == null) ? " (some runs have no km, so they're estimated from duration)" : "";
    if (w.longLimit != null && longPlan > w.longLimit + 0.5)
      add("red", `Longest run ${longPlan.toFixed(1)} km: over your limit of ${w.longLimit} km${runEst}.`);
    if (prevRun > 0 && cur.runKm > prevRun * (1 + R.run_increase) && cur.runKm - prevRun > 3)
      add("amber", `Running volume ${pct(cur.runKm / prevRun - 1)} vs your highest of the last 4 weeks (${prevRun.toFixed(0)} → ${cur.runKm.toFixed(0)} km). Keep increases around 10% while rebuilding.`);
    if (prevLong > 0 && longPlan > prevLong * (1 + R.long_run_increase) && longPlan - prevLong > 2)
      add("amber", `Long run jumps from ${prevLong.toFixed(0)} to ${longPlan.toFixed(0)} km.`);

    // load & fitness
    if (ramp > R.ramp_red) add("red", `Fitness would rise ${ramp.toFixed(1)} in one week. Above ${R.ramp_red}, the risk of injury or illness goes up.`);
    else if (ramp > R.ramp_amber) add("amber", `Ambitious week: fitness +${ramp.toFixed(1)}. Fine for 1–2 weeks, then ease off.`);
    if (ratio != null && !isRecovery && !isTaper) {
      if (ratio - 1 > R.jump_red) add("red", `Load ${pct(ratio - 1)} vs your average of the previous 4 weeks. That's a big jump.`);
      else if (ratio - 1 > R.jump_amber) add("amber", `Load ${pct(ratio - 1)} vs the previous 4 weeks.`);
      else if (ratio < R.too_little) add("blue", `Too little: load ${pct(ratio - 1)} vs the previous 4 weeks, fitness ${ramp >= 0 ? "+" : ""}${ramp.toFixed(1)}. If this isn't meant as an easy week, add volume (easy Z2 is the safest).`);
    }
    if (ratio != null && isRecovery && !isTaper && ratio > R.recovery_max)
      add("amber", `Planned as a recovery week, but the load is ${Math.round(ratio * 100)}% of normal. Make it lighter so you actually recover.`);
    if (minForm && minForm.tsb < R.form_red) add("red", `Fatigue gets very high: form ${minForm.tsb.toFixed(0)} on ${fmtDayLong(minFormDay)}.`);
    else if (minForm && minForm.tsb < R.form_amber) add("amber", `Fatigue builds up: form ${minForm.tsb.toFixed(0)} on ${fmtDayLong(minFormDay)}. Sleep and fuel well.`);

    // structure
    const hard = all.filter((s) => s.hard && s.intensity !== "race");
    if (hard.length > R.max_hard) {
      if (/hit/i.test(w.label)) add("info", `HIT block: ${hard.length} hard sessions on purpose. Make sure the next week is easy.`);
      else add("amber", `${hard.length} hard sessions: more than ${R.max_hard} per week is a lot alongside Ironman volume.`);
    }
    if (isRecovery && hard.some((s) => s.intensity === "very_hard") && !isTaper) add("amber", "Very hard intervals in a recovery week. Consider swapping them for Z2.");
    const hardDays = w.days.map((d) => d.sessions.some((s) => s.hard && s.intensity !== "race"));
    const pairs = [];
    for (let i = 0; i < 6; i++) if (hardDays[i] && hardDays[i + 1]) pairs.push(`${PLAN_DAYS[i]}–${PLAN_DAYS[i + 1]}`);
    if (pairs.length) add("amber", `Hard sessions on back-to-back days (${pairs.join(", ")}). Put an easy day in between if you can.`);
    const endMin = endurance.reduce((s, x) => s + x.mins, 0);
    const easyMin = endurance.filter((s) => !s.hard).reduce((s, x) => s + x.mins, 0);
    if (endMin > 120 && easyMin / endMin < R.easy_share)
      add("amber", `Only ${Math.round((easyMin / endMin) * 100)}% of swim/bike/run time is easy. Aim for 70–80% for Ironman.`);
    const restDays = w.days.filter((d) => !d.sessions.length).length;
    if (!restDays && !isTaper) {
      let streak = 1;
      for (let k = wi - 1; k >= 0 && !weeks[k].days.some((d) => !d.sessions.length); k--) streak++;
      add("info", streak > 1 ? `No full rest day for ${streak} weeks in a row. One easy day off per week helps you absorb the training.` : "No full rest day this week.");
    }

    // this week: readiness + compliance
    if (isCurrent) {
      const ready = readiness();
      if (ready.flags) {
        const next = w.days.filter((d) => d.date >= TODAY).flatMap((d) => d.sessions.filter((s) => s.hard).map((s) => ({ d, s })))[0];
        add("amber", `${ready.notes.join(" ")} ${next ? `Consider swapping ${fmtDayLong(next.d.date)}'s ${next.s.name} for an easy Z2 session.` : "Keep the next days easy."}`);
      }
      const pastDays = w.days.filter((d) => d.date < TODAY);
      const planned = pastDays.reduce((s, d) => s + d.sessions.reduce((a, x) => a + x.mins, 0), 0) / 60;
      const done = pastDays.reduce((s, d) => s + actualsFor(d.date).reduce((a, x) => a + (x.dur_s || 0), 0), 0) / 3600;
      if (planned >= 2 && done < planned * 0.6) add("info", `So far ${fmtHM(done * 3600)} of ${fmtHM(planned * 3600)} planned. Don't cram missed sessions into the rest of the week. Keep the key ones.`);
      else if (planned >= 2 && done > planned * 1.3) add("amber", `You've done ${fmtHM(done * 3600)}, more than planned (${fmtHM(planned * 3600)}). Watch your recovery.`);
    }

    const order = { red: 0, amber: 1, blue: 2, info: 3 };
    msgs.sort((a, b) => order[a.level] - order[b.level]);
    const worst = msgs.find((m) => m.level !== "info");
    const verdict = !worst ? "green" : worst.level;
    if (!worst) msgs.unshift({ level: "green", text: isRecovery ? "Good recovery week: lighter load, fitness holds." : "Balanced week: load, ramp and structure look good." });
    Object.assign(w, { msgs, verdict, plannedH, bySport, runKmPlan: cur.runKm, longPlan, load: cur.load, prevLoad, ratio, ramp, ctlEnd: end.ctl, minForm: minForm ? minForm.tsb : null, isRecovery });
  });
  COACH = { weeks, proj };
  return COACH;
}

/* ------------------------------------------------------------------ render */
const VERDICT = {
  red: ["bad", "▲ Overload risk"], amber: ["warn", "◆ Check"], blue: ["blue", "▼ Too little"], green: ["good", "● On track"],
};
const MSG_ICON = { red: "▲", amber: "◆", blue: "▼", green: "●", info: "i" };
let PLAN_OFFSET = 0;

function renderCoach() {
  const el = document.getElementById("coach");
  if (!el) return;
  const c = buildCoach();
  const w0 = c.weeks[0];
  const v = VERDICT[w0.verdict];
  const rows = c.weeks.map((w, i) => {
    const vv = VERDICT[w.verdict];
    const sportBar = ["swim", "bike", "run", "strength", "other"].filter((k) => w.bySport[k]).map((k) =>
      `<span style="flex:${w.bySport[k]} 0 0;background:${SPORT[k].color}" title="${SPORT[k].name} ${fmtHM(w.bySport[k] * 3600)}"></span>`).join("");
    return `<tr data-i="${i}" class="${i === PLAN_OFFSET ? "sel" : ""}">
      <td>${i === 0 ? "<b>This week</b>" : fmtDay(w.monday)}</td>
      <td class="lbl">${esc(w.label || "–")}${w.source === "auto" ? ' <span class="muted">(auto)</span>' : ""}</td>
      <td class="num">${fmtH(w.plannedH)} h</td>
      <td><div class="minibar">${sportBar}</div></td>
      <td class="num">${w.runKmPlan ? w.runKmPlan.toFixed(0) : "–"}${w.runLimit != null ? ` <span class="muted">/ ${w.runLimit}</span>` : ""} km</td>
      <td class="num">${w.ratio != null ? `${w.ratio >= 1 ? "+" : ""}${Math.round((w.ratio - 1) * 100)}%` : "–"}</td>
      <td class="num">${w.ctlEnd.toFixed(0)} <span class="muted">(${w.ramp >= 0 ? "+" : ""}${w.ramp.toFixed(1)})</span></td>
      <td class="num">${w.minForm != null ? w.minForm.toFixed(0) : "–"}</td>
      <td><span class="pill ${vv[0]}">${vv[1]}</span></td></tr>`;
  }).join("");
  el.innerHTML = `
    <div class="coach-top">
      <div class="verdict ${v[0]}"><span class="pill ${v[0]}">${v[1]}</span><span class="muted">this week</span></div>
      <ul class="cmsgs">${w0.msgs.map((m) => `<li class="${m.level}"><span class="ic">${MSG_ICON[m.level]}</span>${esc(m.text)}</li>`).join("")}</ul>
    </div>
    <div class="table-wrap"><table class="coach-table">
      <thead><tr><th>Week</th><th>Plan</th><th class="num">Hours</th><th>Mix</th><th class="num">Run</th><th class="num">Load vs 4 wk</th><th class="num">Fitness (Δ)</th><th class="num">Lowest form</th><th>Coach</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    <p class="muted" style="margin-top:8px">Loads are estimated from your own Garmin history (load per hour per sport; easy run pace ${fmtClock(CAL.runPace)}/km, bike ${CAL.bikeKmh.toFixed(0)} km/h, swim ${fmtClock(CAL.swimPace)}/100 m). Click a week to open it in the plan.</p>`;
  el.querySelectorAll("tr[data-i]").forEach((tr) => tr.addEventListener("click", () => {
    PLAN_OFFSET = +tr.dataset.i; renderPlan(); renderCoachSel();
    document.getElementById("plan").scrollIntoView({ behavior: "smooth", block: "start" });
  }));
}
function renderCoachSel() {
  document.querySelectorAll("#coach tr[data-i]").forEach((tr) => tr.classList.toggle("sel", +tr.dataset.i === PLAN_OFFSET));
}

function renderPlan() {
  const el = document.getElementById("plan");
  if (!el) return;
  if (!COACH) buildCoach();
  const w = COACH.weeks[PLAN_OFFSET] || weekPlan(addDays(M.thisWeek, 7 * PLAN_OFFSET));
  const nav = document.getElementById("plan-week");
  if (nav) nav.textContent = PLAN_OFFSET === 0 ? "This week" : PLAN_OFFSET === 1 ? "Next week" : `Week of ${fmtDay(w.monday)}`;
  const v = w.verdict ? VERDICT[w.verdict] : null;
  const chips = ["swim", "bike", "run", "strength", "other"].filter((k) => w.bySport && w.bySport[k] > 0.05).map((k) =>
    `<span class="chip"><i style="background:${SPORT[k].color}"></i>${SPORT[k].name.replace(" & other", "")} ${fmtHM(w.bySport[k] * 3600)}</span>`).join("");
  const done = w.days.flatMap((d) => actualsFor(d.date)).reduce((s, a) => s + (a.dur_s || 0) / 3600, 0);

  const dayHtml = w.days.map((d, i) => {
    const past = d.date < TODAY, today = d.date === TODAY;
    const acts = actualsFor(d.date);
    const doneHtml = acts.map((a) => `<div class="done"><span class="dot" style="background:${(SPORT[a.sport] || SPORT.other).color}"></span>✓ ${esc(a.name)} · ${fmtHM(a.dur_s)}</div>`).join("");
    const planned = d.sessions.length ? d.sessions.map((s) => {
      const color = (SPORT[s.sport] || SPORT.other).color;
      const dur = `${s.est ? "~" : ""}${fmtHM(s.mins * 60)}`;
      const dist = s.km ? `${s.km} km · ` : "";
      const tag = s.intensity === "race" ? "Race" : s.hard ? (s.intensity === "very_hard" ? "Very hard" : "Hard") : s.long ? "Long" : "";
      return `<div class="sess${past || (today && acts.length) ? " faded" : ""}" style="border-left-color:${color}">
        <div class="st">${esc(s.name)} <span>${dist}${dur}</span></div>
        ${s.target || s.note ? `<div class="sd">${esc([s.note, s.target].filter(Boolean).join(" · "))}</div>` : ""}
        ${tag ? `<div class="tag ${s.hard ? "hard" : ""}">${tag}</div>` : ""}</div>`;
    }).join("") : `<div class="sess rest"><div class="st">Rest day</div></div>`;
    return `<div class="pday${today ? " today" : ""}${past ? " past" : ""}">
      <div class="ph"><b>${PLAN_DAYS[i]}</b> ${parse(d.date).getDate()}. ${MONTHS[parse(d.date).getMonth()]}${today ? ' <span class="now">Today</span>' : ""}</div>
      ${doneHtml}${doneHtml && d.sessions.length ? '<div class="plbl">planned</div>' : ""}${planned}</div>`;
  }).join("");

  el.innerHTML = `
    <div class="plan-sum">
      <div>${w.label ? `<span class="phase">${esc(w.label)}</span>` : ""}${w.phase && w.phase !== w.label ? `<span class="muted">${esc(w.phase)}</span>` : ""}
        ${v ? ` <span class="pill ${v[0]}" style="margin-left:6px">${v[1]}</span>` : ""}
        ${w.source === "auto" ? ' <span class="muted">· automatic suggestion</span>' : ""}</div>
      ${w.comment ? `<div class="comment">${esc(w.comment)}</div>` : ""}
      <div class="chips">${chips}<span class="chip total">Total ${fmtHM((w.plannedH || 0) * 3600)}</span>
        ${w.runKmPlan ? `<span class="chip">Run ${w.runKmPlan.toFixed(0)} km${w.runLimit != null ? ` / limit ${w.runLimit}` : ""}</span>` : ""}
        ${PLAN_OFFSET === 0 ? `<span class="chip">Done so far ${fmtHM(done * 3600)}</span>` : ""}</div>
      ${w.msgs && PLAN_OFFSET !== 0 ? `<ul class="cmsgs small">${w.msgs.filter((m) => m.level !== "green").map((m) => `<li class="${m.level}"><span class="ic">${MSG_ICON[m.level]}</span>${esc(m.text)}</li>`).join("")}</ul>` : ""}
    </div>
    <div class="pweek">${dayHtml}</div>`;
}

function initPlanTabs() {
  document.querySelectorAll("#plan-nav button[data-n]").forEach((b) => b.addEventListener("click", () => {
    const n = +b.dataset.n;
    PLAN_OFFSET = n === 0 ? 0 : Math.max(0, Math.min(8, PLAN_OFFSET + n));
    renderPlan(); renderCoachSel();
  }));
}
