/* Weekly training plan — rule-based, built from your own numbers.
 *
 * How it decides:
 *  1. Phase from the weeks to your next race (A-race preferred):
 *     Base (>12 wk) · Build (5–12) · Peak (3–4) · Taper (1–2) · Race week · Recovery (week after a race)
 *  2. Volume: your weekly targets (config.json), but never more than ~10% above
 *     your average of the last 4 completed weeks (safe progression).
 *  3. Every 4th week is a lighter recovery week (≈ −35%) during Base/Build.
 *  4. Fatigue & readiness: very negative form (TSB), low/unbalanced HRV or an elevated
 *     resting HR make the plan lighter and turn the next hard session into an easy one.
 *
 * The weekly template (which day gets what) is TEMPLATE below — change it to fit your week.
 * Day index: 0 = Mon … 6 = Sun.
 */
"use strict";

const PLAN_DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// role: key = quality session, easy, long, brick (run straight off the bike), technique, main
const TEMPLATE = [
  { day: 1, sport: "bike", role: "key", share: 0.30 },
  { day: 3, sport: "bike", role: "easy", share: 0.25 },
  { day: 5, sport: "bike", role: "long", share: 0.45 },
  { day: 2, sport: "run", role: "key", share: 0.30 },
  { day: 4, sport: "run", role: "easy", share: 0.20 },
  { day: 5, sport: "run", role: "brick", share: 0.10 }, // only in Build / Peak
  { day: 6, sport: "run", role: "long", share: 0.40 },
  { day: 1, sport: "swim", role: "technique", share: 0.5 },
  { day: 3, sport: "swim", role: "main", share: 0.5 },
  { day: 2, sport: "strength", role: "main", share: 0.5 },
  { day: 4, sport: "strength", role: "main", share: 0.5 },
];
const REST_DAY = 0;
const MIN_MINUTES = { swim: 20, bike: 30, run: 20, strength: 20 };

const PHASE_INFO = {
  Base: { factor: 1.0, text: "Building aerobic endurance. Mostly easy Z2, one moderate session per sport." },
  Build: { factor: 1.0, text: "Adding race-specific intensity: threshold intervals and brick runs." },
  Peak: { factor: 1.0, text: "Hardest, most race-like weeks. Race-pace work and bricks." },
  Taper: { factor: 0.65, text: "Less volume, keep some intensity so you arrive fresh and sharp." },
  "Race week": { factor: 0.4, text: "Short and sharp. Openers only, rest before the race." },
  Recovery: { factor: 0.5, text: "Recover from the race. Easy, short, whatever feels good." },
};

function describe(sport, role, phase, easyOnly) {
  const P = phase;
  const light = easyOnly || P === "Recovery";
  if (sport === "bike") {
    if (role === "long") return P === "Peak" ? ["Long ride", "Z2 with 3×15 min at race effort"] :
      P === "Taper" || P === "Race week" ? ["Endurance ride", "Steady Z2, a few short race-pace efforts"] : ["Long ride", "Steady Z2 endurance, fuel like on race day"];
    if (role === "key" && !light) return {
      Base: ["Tempo ride", "Warm up, 3×10 min Z3 (tempo), 5 min easy between"],
      Build: ["Threshold intervals", "Warm up, 4×8 min Z4 (threshold), 4 min easy between"],
      Peak: ["Race-pace ride", "Warm up, 2×20 min at race effort, 5 min easy between"],
      Taper: ["Openers", "Easy with 5×1 min hard, 2 min easy between"],
      "Race week": ["Openers", "Easy with 4×30 s at race effort"],
    }[P];
    return ["Easy ride", "Z1–Z2, relaxed cadence 85–95 rpm"];
  }
  if (sport === "run") {
    if (role === "long") return P === "Peak" ? ["Long run", "Z2, last 15 min at race pace"] : ["Long run", "Easy Z2, conversational pace"];
    if (role === "brick") return ["Brick run", "Straight off the bike, first 5 min easy, then race pace"];
    if (role === "key" && !light) return {
      Base: ["Easy run + strides", "Z2 with 6×20 s strides at the end"],
      Build: ["Threshold run", "Warm up, 5×4 min Z4, 2 min jog between"],
      Peak: ["Race-pace run", "Warm up, 3×10 min at race pace, 3 min jog between"],
      Taper: ["Short intervals", "Easy with 4×2 min at race pace"],
      "Race week": ["Shakeout", "Easy with 4×20 s strides"],
    }[P];
    return ["Easy run", "Z1–Z2, keep it truly easy"];
  }
  if (sport === "swim") {
    if (role === "main" && !light && (P === "Build" || P === "Peak")) return ["Swim main set", "Warm up 400, 8×100 m at threshold pace, 15 s rest"];
    if (role === "main" && !light) return ["Aerobic swim", "Warm up, 4×200 m steady, 20 s rest"];
    return ["Technique swim", "Drills (catch-up, fist, kick) + easy 100s"];
  }
  if (sport === "strength") {
    if (P === "Peak") return ["Strength (maintenance)", "Lighter loads: squats, lunges, core"];
    if (light) return ["Mobility & core", "20 min mobility, planks, glute activation"];
    return ["Strength", "Squats, deadlifts, lunges, step-ups, core"];
  }
  return ["Session", ""];
}

function planPhase(monday) {
  const races = (CONFIG.races || []).slice().sort((a, b) => (a.date < b.date ? -1 : 1));
  const sunday = addDays(monday, 6);
  const raceThisWeek = races.filter((r) => r.date >= monday && r.date <= sunday);
  const recentRace = races.find((r) => r.date < monday && daysBetween(r.date, monday) <= 7 && (r.priority || "A") === "A");
  const upcoming = races.filter((r) => r.date > sunday);
  const goal = upcoming.find((r) => (r.priority || "A") === "A") || upcoming[0];
  const aThisWeek = raceThisWeek.find((r) => (r.priority || "A") === "A");
  let phase, weeksTo = null;
  if (aThisWeek) phase = "Race week";
  else if (recentRace) phase = "Recovery";
  else if (!goal) phase = "Base";
  else {
    weeksTo = Math.floor(daysBetween(monday, goal.date) / 7);
    phase = weeksTo > 12 ? "Base" : weeksTo > 4 ? "Build" : weeksTo > 2 ? "Peak" : "Taper";
  }
  return { phase, goal: aThisWeek || goal, weeksTo, raceThisWeek };
}

function weekHours(w) { return DISCIPLINES.concat("other").reduce((s, k) => s + (M.wk[w] ? M.wk[w][k].h : 0), 0); }

// Was this past week a light / recovery week? (< 75% of the 4 weeks before it)
function wasLight(w) {
  const prev = [1, 2, 3, 4].map((i) => weekHours(addDays(w, -7 * i))).filter((h) => h > 0);
  if (!prev.length) return false;
  return weekHours(w) < 0.75 * (prev.reduce((a, b) => a + b, 0) / prev.length);
}

function readiness() {
  const notes = [];
  let flags = 0;
  const p = M.pmc[M.pmc.length - 1];
  if (p && p.tsb < -30) { flags++; notes.push(`Form is very low (${p.tsb.toFixed(0)}): fatigue is high.`); }
  const recent = [0, 1, 2].map((i) => M.health[addDays(TODAY, -i)]).filter(Boolean);
  const badHrv = recent.filter((r) => ["LOW", "POOR", "UNBALANCED"].includes((r.hrv_status || "").toUpperCase())).length;
  if (badHrv >= 2) { flags++; notes.push("HRV has been low/unbalanced for 2 of the last 3 nights."); }
  const rhr = lastHealth("rhr", 1), base = avgHealth("rhr", 28, 1);
  if (rhr && base && rhr.v - base >= 5) { flags++; notes.push(`Resting HR is ${Math.round(rhr.v - base)} bpm above your 4-week average.`); }
  return { flags, notes };
}

function buildPlan(monday, isCurrent, prevWasRecovery) {
  const { phase, goal, weeksTo, raceThisWeek } = planPhase(monday);
  const notes = [];
  const targets = CONFIG.weekly_targets_hours || {};
  const thisWeek = M.thisWeek;

  // reference: the last 4 completed weeks
  const ref = [1, 2, 3, 4].map((i) => addDays(thisWeek, -7 * i));
  const refH = (k) => ref.reduce((s, w) => s + (M.wk[w] ? M.wk[w][k].h : 0), 0) / 4;
  const refTotal = DISCIPLINES.reduce((s, k) => s + refH(k), 0);
  const tgtTotal = DISCIPLINES.reduce((s, k) => s + (targets[k] || 0), 0);

  // recovery week every 4th week in Base/Build
  let recovery = false;
  if (phase === "Base" || phase === "Build") {
    const prior = isCurrent ? ref.slice(0, 3) : null;
    recovery = isCurrent ? prior.every((w) => !wasLight(w) && weekHours(w) > 0) : !prevWasRecovery && ref.slice(0, 2).every((w) => !wasLight(w) && weekHours(w) > 0);
    if (recovery) notes.push("3 solid weeks in a row, so this is a lighter recovery week (≈ −35%).");
  }

  // total volume
  let total = tgtTotal || refTotal * 1.05;
  if (refTotal > 0) {
    const cap = Math.max(refTotal * 1.1, refTotal + 0.75);
    if (total > cap) { notes.push(`Capped at ${cap.toFixed(1)} h (your 4-week average ${refTotal.toFixed(1)} h + 10%) to build up safely toward your ${tgtTotal} h target.`); total = cap; }
  }
  let factor = PHASE_INFO[phase].factor * (recovery ? 0.65 : 1);
  const ready = readiness();
  let easyFirstKeys = 0;
  if (ready.flags) {
    notes.push(...ready.notes);
    if (isCurrent) { easyFirstKeys = ready.flags >= 2 ? 2 : 1; notes.push(`The next ${easyFirstKeys === 1 ? "hard session is" : "two hard sessions are"} switched to easy.`); }
    else if (ready.flags >= 2) { factor *= 0.85; notes.push("Next week is 15% lighter because of these recovery signals."); }
  }
  if (raceThisWeek.some((r) => (r.priority || "A") !== "A") && phase !== "Race week") { factor *= 0.85; notes.push("B-race this week: volume reduced, easy the day before."); }
  total *= factor;

  // split by sport
  const shares = {};
  DISCIPLINES.forEach((k) => (shares[k] = tgtTotal ? (targets[k] || 0) / tgtTotal : refTotal ? refH(k) / refTotal : 0.25));
  if (phase === "Taper" || phase === "Race week" || phase === "Recovery") { total -= total * shares.strength * 0.5; }
  const sportH = Object.fromEntries(DISCIPLINES.map((k) => [k, total * shares[k]]));

  // place sessions
  const days = PLAN_DAYS.map((name, i) => ({ date: addDays(monday, i), sessions: [], rest: i === REST_DAY }));
  const brick = phase === "Build" || phase === "Peak";
  DISCIPLINES.forEach((k) => {
    let slots = TEMPLATE.filter((s) => s.sport === k && (s.role !== "brick" || brick));
    if (k === "strength" && sportH.strength < 0.75) slots = slots.slice(0, 1);
    if (k === "swim" && sportH.swim >= 3) slots = slots.concat({ day: REST_DAY, sport: "swim", role: "technique", share: 0.25 });
    let mins = slots.map((s) => s.share);
    const sum = mins.reduce((a, b) => a + b, 0);
    mins = mins.map((s) => (sportH[k] * 60 * s) / sum);
    // drop sessions below the minimum, giving their time to the biggest one
    let changed = true;
    while (changed && slots.length > 1) {
      changed = false;
      const i = mins.findIndex((m) => m < MIN_MINUTES[k]);
      if (i >= 0) {
        const big = mins.indexOf(Math.max(...mins.filter((_, j) => j !== i)));
        mins[big] += mins[i]; mins.splice(i, 1); slots.splice(i, 1); changed = true;
      }
    }
    slots.forEach((s, i) => {
      const m = Math.round(mins[i] / 5) * 5;
      if (m < 15) return;
      days[s.day].sessions.push({ sport: k, role: s.role, mins: m });
    });
  });

  // races in the week: race day + easy day before
  raceThisWeek.forEach((r) => {
    const i = daysBetween(monday, r.date);
    days[i].sessions = [{ sport: "race", race: r, mins: 0 }];
    if (i > 0) days[i - 1].sessions = [{ sport: "run", role: "shakeout", mins: 20 }];
    for (let j = i + 1; j < 7 && j <= i + 2; j++) days[j].sessions = days[j].sessions.filter((s) => s.sport === "swim" || s.sport === "bike").slice(0, 1).map((s) => ({ ...s, role: "easy", mins: Math.min(s.mins, 45) }));
  });

  // describe + readiness swaps (only for today and later)
  let swaps = easyFirstKeys;
  const order = { swim: 0, bike: 1, run: 2, strength: 3 };
  days.forEach((d) => {
    d.sessions.sort((a, b) => (order[a.sport] ?? 9) - (order[b.sport] ?? 9));
    d.sessions.forEach((s) => {
      if (s.sport === "race") { s.title = `🏁 ${s.race.name}`; s.detail = "Race day. Good luck!"; return; }
      if (s.role === "shakeout") { s.title = "Shakeout"; s.detail = "20 min very easy + 3 short strides, or rest"; s.sport = "run"; return; }
      let easyOnly = false;
      if (s.role === "key" && swaps > 0 && d.date >= TODAY) { easyOnly = true; swaps--; s.swapped = true; }
      [s.title, s.detail] = describe(s.sport, s.role, recovery && phase !== "Peak" ? "Recovery" : phase, easyOnly);
      s.key = s.role === "key" && !easyOnly && phase !== "Recovery" && !recovery;
      if (s.role === "long") s.key = true;
      if (/^Easy|Technique|Mobility/.test(s.title)) s.key = false;
    });
  });

  return { monday, phase, recovery, goal, weeksTo, total, refTotal, sportH, days, notes };
}

/* ------------------------------------------------------------------ render */
let PLAN_TAB = "this";
function renderPlan() {
  const el = document.getElementById("plan");
  if (!el) return;
  const cur = buildPlan(M.thisWeek, true);
  const nxt = buildPlan(addDays(M.thisWeek, 7), false, cur.recovery);
  const plan = PLAN_TAB === "this" ? cur : nxt;

  const phaseLine = plan.goal && plan.weeksTo != null
    ? `${plan.weeksTo} weeks to ${esc(plan.goal.name)}`
    : plan.goal ? esc(plan.goal.name) : "No race set. Add one in config.json";
  const chips = DISCIPLINES.filter((k) => plan.sportH[k] > 0.05).map((k) =>
    `<span class="chip"><i style="background:${SPORT[k].color}"></i>${SPORT[k].name} ${fmtHM(plan.sportH[k] * 3600)}</span>`).join("");
  const diff = plan.refTotal ? Math.round((plan.total / plan.refTotal - 1) * 100) : null;

  const actualsByDay = {};
  M.acts.filter((a) => a.date >= plan.monday && a.date <= addDays(plan.monday, 6))
    .forEach((a) => (actualsByDay[a.date] = actualsByDay[a.date] || []).push(a));
  const doneH = Object.values(actualsByDay).flat().reduce((s, a) => s + (a.dur_s || 0) / 3600, 0);

  const dayHtml = plan.days.map((d, i) => {
    const past = d.date < TODAY, today = d.date === TODAY;
    const acts = actualsByDay[d.date] || [];
    const done = acts.map((a) => `<div class="done"><span class="dot" style="background:${(SPORT[a.sport] || SPORT.other).color}"></span>✓ ${esc(a.name)} · ${fmtHM(a.dur_s)}</div>`).join("");
    const planned = d.sessions.length ? d.sessions.map((s) => {
      const color = s.sport === "race" ? "var(--text-primary)" : SPORT[s.sport].color;
      return `<div class="sess${past || (today && acts.length) ? " faded" : ""}${s.key ? " key" : ""}" style="border-left-color:${color}">
        <div class="st">${esc(s.title)}${s.mins ? ` <span>${fmtHM(s.mins * 60)}</span>` : ""}</div>
        <div class="sd">${esc(s.detail)}${s.swapped ? " · <b>eased: recovery signals</b>" : ""}</div>
        ${s.key ? `<div class="tag">Key</div>` : ""}</div>`;
    }).join("") : `<div class="sess rest"><div class="st">Rest day</div><div class="sd">Mobility, sleep, eat well</div></div>`;
    return `<div class="pday${today ? " today" : ""}${past ? " past" : ""}">
      <div class="ph"><b>${PLAN_DAYS[i]}</b> ${parse(d.date).getDate()}. ${MONTHS[parse(d.date).getMonth()]}${today ? ' <span class="now">Today</span>' : ""}</div>
      ${done}${done && (past || today) && d.sessions.length ? '<div class="plbl">planned</div>' : ""}${planned}</div>`;
  }).join("");

  el.innerHTML = `
    <div class="plan-sum">
      <div><span class="phase">${plan.recovery ? "Recovery week" : plan.phase}</span>
        <span class="muted">${phaseLine}. ${plan.recovery ? "Lighter week to absorb the training." : PHASE_INFO[plan.phase].text}</span></div>
      <div class="chips">${chips}<span class="chip total">Total ${fmtHM(plan.total * 3600)}${diff != null ? ` · ${diff >= 0 ? "+" : ""}${diff}% vs 4-wk avg` : ""}</span>
        ${PLAN_TAB === "this" ? `<span class="chip">Done so far ${fmtHM(doneH * 3600)}</span>` : ""}</div>
      ${plan.notes.length ? `<ul class="notes">${plan.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
    </div>
    <div class="pweek">${dayHtml}</div>
    <p class="muted" style="margin-top:10px">Generated automatically from your Garmin data, targets and races. It's a guide, not a coach, so listen to your body. Zones are your Garmin HR zones.</p>`;
}

function initPlanTabs() {
  const seg = document.getElementById("plan-tab");
  if (!seg) return;
  seg.querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
    seg.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    PLAN_TAB = b.dataset.p; renderPlan();
  }));
}
