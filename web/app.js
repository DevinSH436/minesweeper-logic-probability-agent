/* Front end for the Minesweeper agent site.  No libraries: plain DOM + SVG. */
"use strict";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const key = (r, c) => `${r},${c}`;
const pct = (x, d = 1) => (x == null ? "–" : `${(x * 100).toFixed(d)}%`);
const BOARD_NAMES = { beginner: "Beginner", intermediate: "Intermediate", expert: "Expert", custom: "Custom" };
const PLAYERS = {
  probability: { label: "Logic + probability", color: "var(--series-1)" },
  logic: { label: "Logic only", color: "var(--series-2)" },
  rules: { label: "Local rules", color: "var(--series-3)" },
  random: { label: "Random", color: "var(--series-4)" },
};
const ORDER = ["probability", "logic", "rules", "random"];
const REASON_TEXT = {
  "opening": "Opening move",
  "proven-safe": "Proven safe",
  "min-probability": "Lowest P(mine)",
  "forced-guess": "Forced guess",
  "random": "Random click",
};

async function api(path, body) {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

/* ------------------------------------------------------------------ theme */
(function theme() {
  const root = document.documentElement;
  try { const t = localStorage.getItem("theme"); if (t) root.dataset.theme = t; } catch (e) { /* storage blocked */ }
  $("#themeBtn").addEventListener("click", () => {
    const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    root.dataset.theme = dark ? "light" : "dark";
    try { localStorage.setItem("theme", root.dataset.theme); } catch (e) { /* ignore */ }
    if (window.__redrawCharts) window.__redrawCharts();
  });
})();

/* ------------------------------------------------------------------ tabs */
const TABS = $$("#tabs button").map(b => b.dataset.tab);
function showTab(name) {
  if (!TABS.includes(name)) name = "overview";
  $$("#tabs button").forEach(b => b.classList.toggle("active", b.dataset.tab === name));
  $$("section.tab").forEach(s => s.classList.toggle("active", s.id === `tab-${name}`));
  if (name === "live") Live.ensure();
  if (name === "walkthrough") Walk.ensure();
  if (name === "experiment") { Example.ensure(); Runner.ensure(); }
  window.scrollTo({ top: 0 });
}
$("#tabs").addEventListener("click", e => {
  const b = e.target.closest("button[data-tab]");
  if (b) location.hash = b.dataset.tab;
});
window.addEventListener("hashchange", () => showTab(location.hash.slice(1)));

/* ------------------------------------------------------------------ tooltip */
const tip = $("#tooltip");
document.addEventListener("mousemove", e => {
  const t = e.target.closest("[data-tip]");
  if (!t) { tip.classList.remove("show"); return; }
  tip.innerHTML = t.dataset.tip;
  tip.classList.add("show");
  const x = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8);
  const y = e.clientY + 16 + tip.offsetHeight > innerHeight ? e.clientY - tip.offsetHeight - 10 : e.clientY + 16;
  tip.style.left = `${x}px`; tip.style.top = `${y}px`;
});

/* ------------------------------------------------------------------ board renderer */
const RAMP = [[205, 226, 251], [57, 135, 229], [13, 54, 107]];   // sequential blue: low -> high P(mine)
function rampColor(p) {
  const t = Math.max(0, Math.min(1, p)) * 2;
  const [a, b] = t <= 1 ? [RAMP[0], RAMP[1]] : [RAMP[1], RAMP[2]];
  const f = t <= 1 ? t : t - 1;
  return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * f)).join(",")})`;
}
const COMP_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];

function cellSize(cols) { return cols <= 9 ? 40 : cols <= 16 ? 31 : 26; }

/**
 * Draw a board.
 * st: {rows, cols, view, status, mine_cells?, exploded?}
 * o:  {probs: Map, safe: Set, mines: Set, showProbs, last, newly: Set, clickable, onClick, onFlag,
 *      flags: Set, extra: Map key -> {cls: [], style: ""}, showMinesOnLoss}
 */
function renderBoard(el, st, o = {}) {
  const size = o.size || cellSize(st.cols);
  el.style.setProperty("--cols", st.cols);
  el.style.setProperty("--size", `${size}px`);
  el.classList.toggle("clickable", !!o.clickable);
  const mineSet = new Set((st.mine_cells || []).map(([r, c]) => key(r, c)));
  const boom = st.exploded ? key(...st.exploded) : null;
  const showText = size >= 28;
  let html = "";
  for (let r = 0; r < st.rows; r++) {
    for (let c = 0; c < st.cols; c++) {
      const k = key(r, c), v = st.view[r][c];
      const cls = ["cell"];
      let inner = "", style = "", tipText = "";
      if (v >= 0) {
        if (v > 0) { cls.push(`n${v}`); inner = v; }
      } else if (mineSet.has(k) && st.status === "lost") {
        cls.push("mine"); if (k === boom) cls.push("boom");
      } else {
        cls.push("hidden");
        if (mineSet.has(k)) cls.push("minefound");
        else if (o.mines && o.mines.has(k)) { cls.push("minefound"); tipText = "Proven mine: a mine in every consistent layout"; }
        else if (o.safe && o.safe.has(k)) { cls.push("safe"); tipText = "Proven safe: a mine in no consistent layout"; }
        else if (o.flags && o.flags.has(k)) cls.push("flag");
        else if (o.showProbs && o.probs && o.probs.has(k)) {
          const p = o.probs.get(k);
          const txt = p >= 0.995 ? "99" : p < 0.005 ? "0" : Math.round(p * 100);
          inner = `<span class="p" style="background:${rampColor(p)};color:${p > 0.42 ? "#fff" : "#0d366b"}">${showText ? txt + "%" : ""}</span>`;
          tipText = `P(mine) = ${(p * 100).toFixed(1)}%`;
        }
      }
      if (o.last && o.last === k) cls.push("last");
      if (o.newly && o.newly.has(k)) cls.push("newly");
      const ex = o.extra && o.extra.get(k);
      if (ex) { cls.push(...(ex.cls || [])); style += ex.style || ""; if (ex.tip) tipText = ex.tip; }
      html += `<div class="${cls.join(" ")}" data-k="${k}" style="${style}"${tipText ? ` data-tip="${tipText}"` : ""}>${inner}</div>`;
    }
  }
  el.innerHTML = html;
}

function analysisMaps(a) {
  const probs = new Map(), safe = new Set(), mines = new Set();
  if (a) {
    a.probs.forEach(([r, c, p]) => probs.set(key(r, c), p));
    a.safe.forEach(([r, c]) => safe.add(key(r, c)));
    a.mines.forEach(([r, c]) => mines.add(key(r, c)));
  }
  return { probs, safe, mines };
}

/* ================================================================== LIVE BOARD */
const Live = {
  started: false, st: null, a: null, timer: null, flags: new Set(), last: null, newly: null, log: [],
  ensure() { if (!this.started) { this.started = true; this.bind(); this.newGame(); } },
  bind() {
    $("#lvNew").onclick = () => this.newGame();
    $("#lvStep").onclick = () => this.step();
    $("#lvPlay").onclick = () => this.toggle();
    $("#lvBoard").onchange = () => this.newGame();
    $("#lvAgent").onchange = () => this.newGame();
    $("#lvProbs").onchange = () => this.draw();
    $("#lvProofs").onchange = () => this.draw();
    const board = $("#lvBoardEl");
    board.addEventListener("click", e => {
      const cell = e.target.closest(".cell.hidden");
      if (!cell || !this.human() || !this.st || this.over()) return;
      const [r, c] = cell.dataset.k.split(",").map(Number);
      this.humanReveal(r, c);
    });
    board.addEventListener("contextmenu", e => {
      const cell = e.target.closest(".cell.hidden");
      if (!cell || !this.human()) return;
      e.preventDefault();
      const k = cell.dataset.k;
      this.flags.has(k) ? this.flags.delete(k) : this.flags.add(k);
      this.draw();
    });
  },
  human() { return $("#lvAgent").value === "human"; },
  over() { return this.st && (this.st.status === "won" || this.st.status === "lost"); },
  async newGame() {
    this.stop();
    const agent = this.human() ? "probability" : $("#lvAgent").value;
    const seed = $("#lvSeed").value;
    try {
      const d = await api("/api/new", { board: $("#lvBoard").value, agent, seed: seed === "" ? null : Number(seed) });
      this.st = d.state; this.a = null; this.flags.clear(); this.last = null; this.newly = null; this.log = [];
      $("#lvDecision").innerHTML = this.human()
        ? "Your turn. Click a square to reveal it, right-click to flag. Press <b>Step</b> to let the agent make one move for you."
        : "Press <b>Play</b> or <b>Step</b>. The first click is always safe.";
      this.draw();
    } catch (err) { this.error(err); }
  },
  toggle() { this.timer ? this.stop() : this.play(); },
  play() {
    if (this.over()) return;
    $("#lvPlay").textContent = "❚❚ Pause";
    const tick = async () => {
      if (!this.timer) return;
      await this.step();
      if (this.over()) { this.stop(); return; }
      const s = Number($("#lvSpeed").value);
      this.timer = setTimeout(tick, Math.round(1200 * Math.pow(1 - s / 100, 2)) + 15);
    };
    this.timer = setTimeout(tick, 0);
  },
  stop() { clearTimeout(this.timer); this.timer = null; $("#lvPlay").textContent = "▶ Play"; },
  wantExplain() { return $("#lvProbs").checked || $("#lvProofs").checked; },
  async step() {
    if (!this.st || this.over() || this.busy) return;
    this.busy = true;
    try {
      const d = await api("/api/step", { id: this.st.id, explain: this.wantExplain() });
      this.apply(d);
      if (d.decision) this.describe(d.decision, d.analysis_before);
    } catch (err) { this.error(err); this.stop(); }
    this.busy = false;
  },
  async humanReveal(r, c) {
    try {
      const d = await api("/api/reveal", { id: this.st.id, cell: [r, c] });
      this.apply(d, [r, c]);
      const a = this.prevA;
      const p = a ? new Map(a.probs.map(([rr, cc, pp]) => [key(rr, cc), pp])).get(key(r, c)) : null;
      const verdict = a && a.safe.some(([rr, cc]) => rr === r && cc === c) ? "a <b>proven-safe</b> square, good."
        : p != null ? `a square the agent rated at <b>P(mine) = ${pct(p)}</b>.` : "your first click (always safe).";
      $("#lvDecision").innerHTML = this.st.status === "lost" ? `💥 That was a mine. You clicked ${verdict}` : `You revealed ${verdict}`;
      this.log.push({ cell: [r, c], reason: "human", risk: p });
      this.drawLog();
    } catch (err) { this.error(err); }
  },
  apply(d, humanCell) {
    this.prevA = this.a;
    this.st = d.state;
    this.a = d.analysis;
    const cell = humanCell || (d.decision && d.decision.cell);
    this.last = cell ? key(...cell) : null;
    this.newly = new Set((d.newly || []).map(([r, c]) => key(r, c)));
    if (d.decision) this.log.push(d.decision);
    this.draw();
    this.drawLog();
  },
  describe(dec, a) {
    const [r, c] = dec.cell;
    let txt = `<span class="reason ${dec.reason}">${REASON_TEXT[dec.reason] || dec.reason}</span> square (${r}, ${c}). `;
    if (dec.reason === "proven-safe") txt += "No mine layout consistent with the numbers has a mine here, so revealing it cannot lose (KB ⊨ ¬M).";
    else if (dec.reason === "opening") txt += "Nothing is known yet; the first click is always safe.";
    else if (dec.reason === "min-probability") {
      txt += `Nothing was provably safe, so the agent picked the lowest P(mine) = <b>${pct(dec.risk)}</b>`;
      if (a && a.interior_prob != null) txt += ` (an unconstrained interior square was ${pct(a.interior_prob)})`;
      txt += ".";
    } else if (dec.reason === "forced-guess") txt += `Nothing was provably safe and this player cannot compare risks, so it guessed at random. Under the exact model this square had P(mine) = ${pct(dec.risk)}.`;
    else if (dec.reason === "random") txt += "The random player ignores the numbers.";
    if (this.st.status === "lost") txt += " <b>💥 It was a mine. Game lost.</b>";
    if (this.st.status === "won") txt += " <b>🎉 Board cleared. Game won!</b>";
    txt += ` <span class="muted">(${dec.think_ms.toFixed(2)} ms)</span>`;
    $("#lvDecision").innerHTML = txt;
  },
  draw() {
    if (!this.st) return;
    const st = this.st, maps = analysisMaps(this.a);
    const proofs = $("#lvProofs").checked;
    renderBoard($("#lvBoardEl"), st, {
      probs: maps.probs, showProbs: $("#lvProbs").checked,
      safe: proofs ? maps.safe : null, mines: proofs ? maps.mines : null,
      last: this.last, newly: this.newly, clickable: this.human() && !this.over(), flags: this.flags,
    });
    const badge = $("#lvStatus");
    badge.className = `status-badge ${st.status}`;
    badge.textContent = { ready: "Ready", playing: "Playing", won: "Won 🎉", lost: "Lost 💥" }[st.status];
    $("#lvWho").textContent = this.human() ? "You (agent advising)" : PLAYERS[st.agent].label;
    $("#lvMoves").textContent = st.moves;
    $("#lvGuesses").textContent = st.guesses;
    $("#lvLeft").textContent = this.a ? `${st.mines - this.a.mines.length} of ${st.mines}` : `${st.mines}`;
    $("#lvSafeN").textContent = this.a ? this.a.safe.length : "–";
    $("#lvTime").textContent = this.a ? `${this.a.millis.toFixed(2)} ms last analysis` : "–";
    $("#lvSeedOut").textContent = st.seed == null ? "random" : st.seed;
    $("#lvHint").innerHTML = this.a && this.a.components.length
      ? `Current frontier: ${this.a.components.reduce((s, c) => s + c.cells.length, 0)} squares in ${this.a.components.length} independent component(s); ${this.a.interior} interior squares share P(mine) = ${pct(this.a.interior_prob)}.`
      : "";
  },
  drawLog() {
    const el = $("#lvLog");
    el.innerHTML = this.log.slice().reverse().slice(0, 200).map((d, i) => {
      const n = this.log.length - i;
      const reason = d.reason === "human" ? `<span class="reason opening">You</span>` : `<span class="reason ${d.reason}">${REASON_TEXT[d.reason]}</span>`;
      const risk = d.risk != null && d.reason !== "proven-safe" ? `<span class="muted">P=${pct(d.risk)}</span>` : "";
      return `<div><span class="mv">#${n}</span>${reason}<span>(${d.cell[0]}, ${d.cell[1]})</span>${risk}</div>`;
    }).join("") || `<div class="muted">No moves yet.</div>`;
  },
  error(err) { $("#lvDecision").innerHTML = `<span style="color:var(--critical)">${err.message}. Is <code>python server.py</code> running?</span>`; },
};

/* ================================================================== WALKTHROUGH */
const PHASES = [
  { id: "percept", name: "1 · Percept" },
  { id: "kb", name: "2 · Knowledge base" },
  { id: "rules", name: "3 · Single-number rules" },
  { id: "components", name: "4 · Frontier components" },
  { id: "models", name: "5 · Model checking" },
  { id: "probs", name: "6 · Probabilities" },
  { id: "decision", name: "7 · Decision" },
];

const Walk = {
  started: false, st: null, a: null, phase: 0, lastMove: null,
  ensure() { if (!this.started) { this.started = true; this.bind(); this.newBoard(); } },
  bind() {
    $("#wtNew").onclick = () => this.newBoard();
    $("#wtNext").onclick = () => this.go(this.phase + 1);
    $("#wtPrev").onclick = () => this.go(this.phase - 1);
    $("#wtMove").onclick = () => this.move();
    $("#wtSkip").onclick = () => this.skip();
    $("#wtPhases").innerHTML = PHASES.map((p, i) => `<button data-i="${i}">${p.name}</button>`).join("");
    $("#wtPhases").onclick = e => { const b = e.target.closest("button"); if (b) this.go(Number(b.dataset.i)); };
  },
  async newBoard() {
    try {
      const d = await api("/api/new", { board: $("#wtBoard").value, agent: "probability", seed: Number($("#wtSeed").value) });
      this.st = d.state;
      const s = await api("/api/step", { id: this.st.id, fresh: true });   // the opening click
      this.st = s.state; this.a = s.analysis; this.lastMove = key(...s.decision.cell);
      this.go(0);
    } catch (err) { $("#wtBody").innerHTML = `<p style="color:var(--critical)">${err.message}</p>`; }
  },
  async move() {
    if (!this.st || this.st.status !== "playing") return;
    const d = await api("/api/step", { id: this.st.id, fresh: true });
    this.st = d.state; this.a = d.analysis; this.lastMove = key(...d.decision.cell);
    this.go(0);
  },
  interesting(a) {
    if (!a) return true;
    const ruleSafe = new Set(a.rule_steps.filter(s => s.kind === "safe").flatMap(s => s.cells.map(([r, c]) => key(r, c))));
    if (a.safe.length === 0) return true;                               // needs probability
    return a.safe.some(([r, c]) => !ruleSafe.has(key(r, c))) && ruleSafe.size === 0;   // needs model checking
  },
  async skip() {
    this.skipNote = false;
    for (let i = 0; i < 500 && this.st.status === "playing"; i++) {
      const d = await api("/api/step", { id: this.st.id, fresh: true });
      this.st = d.state; this.a = d.analysis; this.lastMove = key(...d.decision.cell);
      if (this.st.status !== "playing") { this.skipNote = true; break; }
      if (this.interesting(this.a)) break;
    }
    this.go(this.a && this.a.safe.length === 0 ? 5 : 3);
  },
  go(i) {
    this.phase = Math.max(0, Math.min(PHASES.length - 1, i));
    $$("#wtPhases button").forEach((b, j) => { b.classList.toggle("on", j === this.phase); b.classList.toggle("done", j < this.phase); });
    this.render();
  },
  /* the decision the agent will make, computed the same way the Python agent does */
  predicted() {
    const a = this.a;
    if (!a) return null;
    const cmp = (x, y) => x[0] - y[0] || x[1] - y[1];
    if (a.safe.length) return { kind: "safe", cells: [a.safe.slice().sort(cmp)[0]] };
    const mines = new Set(a.mines.map(([r, c]) => key(r, c)));
    const cand = a.probs.filter(([r, c]) => this.st.view[r][c] < 0 && !mines.has(key(r, c)));
    const best = Math.min(...cand.map(x => x[2]));
    let tied = cand.filter(x => x[2] <= best + 1e-9);
    const hn = ([r, c]) => { let n = 0; for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) { const rr = r + dr, cc = c + dc; if ((dr || dc) && rr >= 0 && cc >= 0 && rr < this.st.rows && cc < this.st.cols && this.st.view[rr][cc] < 0) n++; } return n; };
    const fewest = Math.min(...tied.map(hn));
    tied = tied.filter(x => hn(x) === fewest);
    return { kind: "prob", cells: tied.map(([r, c]) => [r, c]), p: best };
  },
  render() {
    const st = this.st, a = this.a;
    if (!st) return;
    const ph = PHASES[this.phase].id;
    const extra = new Map(), add = (k, cls, style, tipText) => {
      const e = extra.get(k) || { cls: [], style: "" };
      if (cls) e.cls.push(cls); if (style) e.style += style; if (tipText) e.tip = tipText;
      extra.set(k, e);
    };
    const maps = analysisMaps(a);
    let opts = { last: this.lastMove, extra };
    let body = "", legend = "";
    const over = st.status !== "playing";
    if (over) {
      renderBoard($("#wtBoardEl"), st, { last: this.lastMove });
      $("#wtBody").innerHTML = `<h3>${st.status === "won" ? "🎉 The agent cleared the board" : "💥 The agent hit a mine"}</h3>
        <p>${st.status === "won" ? "Every safe square is revealed." : "A guess went wrong, which can happen with any strategy: some boards cannot be solved without luck."}
        Press <b>New board</b> or change the seed to try again.</p>
        ${this.skipNote ? `<p class="small muted">The rest of this game needed only the simple rules, so skipping ran to the end. Seeds 23, 36 and 42 (beginner) have harder decisions.</p>` : ""}`;
      $("#wtLegend").innerHTML = "";
      return;
    }
    const nRevealed = st.view.flat().filter(v => v >= 0).length;
    const ruleSafe = new Set(), ruleMine = new Set();
    a.rule_steps.forEach(s => s.cells.forEach(([r, c]) => (s.kind === "safe" ? ruleSafe : ruleMine).add(key(r, c))));

    if (ph === "percept") {
      body = `<div class="chapter">AIMA Ch. 2 · Ch. 4.4</div><h3>What the agent can see</h3>
        <p>${nRevealed} square${nRevealed === 1 ? " is" : "s are"} open and show${nRevealed === 1 ? "s a number" : " numbers"}; <b>${a.hidden}</b> are hidden; the counter says
        <b>${st.mines}</b> mines in total. The mines themselves are invisible: the environment is <b>partially observable</b>.</p>
        <p>The highlighted square is the agent's previous move. Everything that follows is computed only from these numbers.</p>
        <p class="small muted">The belief state, the set of mine layouts consistent with this percept, is far too large to list,
        so the agent describes it with logic instead.</p>`;
    } else if (ph === "kb") {
      a.constraints.forEach(c => add(key(...c.src), "hl-src"));
      const nClauses = a.constraints.reduce((s, c) => s + comb(c.cells.length, c.count + 1) + comb(c.cells.length, c.cells.length - c.count + 1), 0);
      const lines = a.constraints.slice(0, 60).map(c =>
        `<div>(${c.src[0]},${c.src[1]})=${c.count}: exactly ${c.count} of {${c.cells.map(([r, cc]) => `M${r}_${cc}`).join(", ")}}</div>`).join("");
      body = `<div class="chapter">AIMA Ch. 7.3 – 7.4</div><h3>TELL: numbers become sentences</h3>
        <p>Each outlined number touches hidden squares, so it adds one sentence to the knowledge base. There are
        <b>${a.constraints.length}</b> such sentences, plus "exactly ${st.mines} mines in total".</p>
        <div class="sentences">${lines}${a.constraints.length > 60 ? `<div>… ${a.constraints.length - 60} more</div>` : ""}</div>
        <p class="small muted" style="margin-top:8px">Written out in CNF these would be about <b>${nClauses.toLocaleString()}</b> clauses.
        The agent reasons on the counting form directly instead.</p>`;
      legend = `<span><i style="outline:3px solid var(--series-2);outline-offset:-3px"></i>number that contributes a sentence</span>`;
    } else if (ph === "rules") {
      a.rule_steps.forEach(s => { add(key(...s.src), "hl-src"); });
      opts.safe = ruleSafe; opts.mines = ruleMine;
      const steps = a.rule_steps.slice(0, 40).map(s => `<div>(${s.src[0]},${s.src[1]})=${s.count} ⇒ ${s.kind === "safe" ? "safe" : "mine"}: ${s.cells.map(([r, c]) => `(${r},${c})`).join(" ")}</div>`).join("");
      body = `<div class="chapter">AIMA Ch. 7.5.1 · unit-propagation style</div><h3>Cheap rules, one number at a time</h3>
        <p>"All its mines are found ⇒ the rest are safe" and "as many unknowns as missing mines ⇒ all mines". Applied until nothing changes,
        they found <b>${ruleSafe.size}</b> safe and <b>${ruleMine.size}</b> mine squares.</p>
        ${steps ? `<div class="sentences">${steps}</div>` : `<p class="callout warn"><b>Nothing found.</b> No single number decides anything here, so the agent needs full model checking.</p>`}
        <p class="small muted" style="margin-top:8px">This stage alone is the <i>Local rules</i> player: sound, but incomplete.</p>`;
      legend = `<span><i style="box-shadow:inset 0 0 0 2.5px var(--good)"></i>safe by a rule</span><span><i style="box-shadow:inset 0 0 0 2.5px var(--critical)"></i>mine by a rule</span>`;
    } else if (ph === "components") {
      opts.safe = ruleSafe; opts.mines = ruleMine;
      a.components.forEach((comp, i) => {
        const col = i < COMP_COLORS.length ? COMP_COLORS[i] : "#8a8a85";
        comp.cells.forEach(([r, c]) => add(key(r, c), "comp", `--cc:${col};`, `Component ${i + 1}: ${comp.cells.length} squares`));
      });
      const rows = a.components.map((comp, i) => `<tr><td><span class="swatch" style="--c:${i < 8 ? COMP_COLORS[i] : "#8a8a85"}"></span> ${i + 1}</td><td class="num">${comp.cells.length}</td><td class="num">${comp.n_constraints}</td></tr>`).join("");
      body = `<div class="chapter">AIMA Ch. 7.4.4 (model checking) · 4.4 (belief states)</div><h3>Split the frontier into independent groups</h3>
        <p>The <b>frontier</b> is the set of undecided hidden squares that touch a number. Squares that share no number cannot
        influence each other, so each coloured group is checked on its own. That turns one huge enumeration into several small ones.</p>
        ${a.components.length ? `<div class="table-wrap"><table><tr><th>Group</th><th class="num">squares</th><th class="num">numbers</th></tr>${rows}</table></div>`
        : `<p class="callout good"><b>No undecided frontier.</b> The rules already settled every square next to a number.</p>`}
        <p class="small" style="margin-top:10px"><b>${a.interior}</b> other hidden squares touch no number (AIMA's "other" squares); <b>${a.remaining_mines}</b> mines are still unaccounted for.</p>`;
      legend = `<span><i style="box-shadow:inset 0 0 0 3px #2a78d6"></i><i style="box-shadow:inset 0 0 0 3px #eb6834"></i> one colour per independent component</span>`;
    } else if (ph === "models") {
      opts.safe = maps.safe; opts.mines = maps.mines;
      a.safe.forEach(([r, c]) => { if (!ruleSafe.has(key(r, c))) add(key(r, c), "", "", "Safe: a mine in none of the models (found by model checking)"); });
      const newSafe = a.safe.filter(([r, c]) => !ruleSafe.has(key(r, c))).length;
      const newMine = a.mines.filter(([r, c]) => !ruleMine.has(key(r, c))).length;
      const rows = a.components.map((comp, i) => `<tr><td>${i + 1}</td><td class="num">${comp.cells.length}</td><td class="num">${typeof comp.models === "number" ? comp.models.toLocaleString() : comp.models}</td><td class="num">${comp.nodes.toLocaleString()}</td><td>${comp.exact ? "exact" : "budget hit → approx."}</td></tr>`).join("");
      body = `<div class="chapter">AIMA Ch. 7.3 · 7.4.4 · entailment</div><h3>ASK: what is true in every model?</h3>
        <p>For each group the agent lists every mine assignment that satisfies all of its numbers (backtracking, pruning any
        number that is overfull or can no longer be filled). Combined with the global mine count, a square that is a mine in
        <b>no</b> model is entailed safe, and one that is a mine in <b>every</b> model is entailed to be a mine.</p>
        ${a.components.length ? `<div class="table-wrap"><table><tr><th>Group</th><th class="num">squares</th><th class="num">models</th><th class="num">search nodes</th><th></th></tr>${rows}</table></div>` : ""}
        <p style="margin-top:10px">Result: <b style="color:var(--good-text)">${a.safe.length} safe</b> and <b style="color:var(--critical)">${a.mines.length} mines</b> proven
        ${newSafe || newMine ? `(<b>${newSafe}</b> safe and <b>${newMine}</b> mines that the simple rules could not find)` : "(nothing beyond the simple rules)"}.
        Analysis took ${a.millis.toFixed(2)} ms.</p>
        ${a.safe.length === 0 ? `<p class="callout warn"><b>No square is provably safe.</b> Logic has done all it can. Next stage: probability.</p>` : ""}`;
      legend = `<span><i style="box-shadow:inset 0 0 0 2.5px var(--good)"></i>entailed safe</span><span><i style="box-shadow:inset 0 0 0 2.5px var(--critical)"></i>entailed mine</span>`;
    } else if (ph === "probs") {
      opts.safe = maps.safe; opts.mines = maps.mines; opts.probs = maps.probs; opts.showProbs = true;
      const und = a.probs.filter(([r, c, p]) => st.view[r][c] < 0 && p > 0 && p < 1);
      const minP = und.length ? Math.min(...und.map(x => x[2])) : null;
      body = `<div class="chapter">AIMA Ch. 12.7 (the Wumpus pit calculation)</div><h3>How likely is each square to be a mine?</h3>
        <p>Every full layout consistent with the numbers is equally likely. Each frontier model with <i>k</i> mines stands for
        C(U, R − k) full layouts (U = ${a.interior} interior squares, R = ${a.remaining_mines} mines left). So</p>
        <div class="formula" style="font-size:.95rem">P(M<sub>x</sub>) = Σ<sub>models with x mined</sub> C(U, R−k) / Σ<sub>all models</sub> C(U, R−k)</div>
        <p>The shading on the board is the exact result. Interior squares all share <b>${pct(a.interior_prob)}</b>.
        ${minP != null ? `The least dangerous undecided square has <b>${pct(minP)}</b>.` : ""}
        ${a.safe.length ? "Here the agent does not need these numbers: it has proven-safe squares available." : ""}</p>`;
      legend = `<span><span class="ramp"></span>P(mine) low → high</span>`;
    } else if (ph === "decision") {
      const pred = this.predicted();
      opts.safe = maps.safe; opts.mines = maps.mines; opts.probs = maps.probs; opts.showProbs = pred && pred.kind === "prob";
      (pred ? pred.cells : []).forEach(([r, c]) => add(key(r, c), "choice"));
      if (pred && pred.kind === "safe") {
        body = `<div class="chapter">Goal-based action (Ch. 7) </div><h3>Reveal a proven-safe square</h3>
          <p>At least one square is entailed safe, so the agent reveals one, (${pred.cells[0][0]}, ${pred.cells[0][1]}), with zero risk.
          Knowledge only grows (monotonicity, AIMA 7.3), so the other ${a.safe.length - 1} proven squares stay safe and are revealed next without re-thinking.</p>`;
      } else if (pred) {
        body = `<div class="chapter">Utility-based action (Ch. 12.1 · maximum expected utility)</div><h3>Take the smallest risk</h3>
          <p>Nothing is provable, so the agent picks the square with the lowest probability of a mine, <b>${pct(pred.p)}</b>, i.e. the
          highest expected utility (survival = 1 − P). ${pred.cells.length > 1 ? `There is a ${pred.cells.length}-way tie (dashed squares); it prefers squares with the fewest hidden neighbours and picks one of those at random.` : ""}</p>
          <p class="small muted">A logic-only player would pick <i>any</i> undecided square at random here, which is why it loses so much more often.</p>`;
      }
      legend = `<span><i style="outline:3px solid var(--text);outline-offset:-3px"></i>the agent's choice</span>`;
    }
    renderBoard($("#wtBoardEl"), st, opts);
    $("#wtBody").innerHTML = body + `<div style="margin-top:14px;display:flex;gap:8px">
        ${this.phase < PHASES.length - 1 ? `<button class="btn primary" onclick="Walk.go(${this.phase + 1})">Next stage ▶</button>` : `<button class="btn primary" onclick="Walk.move()">Make the move ▶</button>`}</div>`;
    $("#wtLegend").innerHTML = legend;
  },
};
window.Walk = Walk;

function comb(n, k) {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = r * (n - k + i) / i;
  return Math.round(r);
}

/* ================================================================== CNF DEMO */
(function cnf() {
  const K = $("#cnfK"), N = $("#cnfN");
  const combos = (arr, size) => {
    const out = [];
    const rec = (start, cur) => {
      if (cur.length === size) { out.push(cur.slice()); return; }
      for (let i = start; i < arr.length; i++) { cur.push(arr[i]); rec(i + 1, cur); cur.pop(); }
    };
    if (size >= 0 && size <= arr.length) rec(0, []);
    return out;
  };
  function draw() {
    const k = Number(K.value);
    N.max = k;
    const n = Math.min(Number(N.value), k);
    const vars = "abcdefgh".slice(0, k).split("");
    const atMost = n < k ? combos(vars, n + 1) : [];
    const atLeast = n > 0 ? combos(vars, k - n + 1) : [];
    $("#cnfSummary").innerHTML = `"exactly <b>${n}</b> of <b>${k}</b>" = <b>${atMost.length}</b> at-most clauses + <b>${atLeast.length}</b> at-least clauses = <b>${atMost.length + atLeast.length}</b>`;
    const show = [...atMost.map(c => `<span class="neg">(${c.map(v => "¬" + v).join(" ∨ ")})</span>`),
      ...atLeast.map(c => `<span class="pos">(${c.join(" ∨ ")})</span>`)];
    $("#cnfClauses").innerHTML = show.join("") || `<span>(no clauses)</span>`;
  }
  K.oninput = draw; N.oninput = draw;
  draw();
})();

/* ================================================================== EXPERIMENTS */
const Exp = { summary: null, cal: null };

function svgEl(svg, w, h) { svg.setAttribute("viewBox", `0 0 ${w} ${h}`); svg.innerHTML = ""; return svg; }

function barChart(svg, rows, metric, opts = {}) {
  const W = 920, H = opts.height || 320, m = { t: 26, r: 12, b: 44, l: 52 };
  svgEl(svg, W, H);
  const boards = ["beginner", "intermediate", "expert"].filter(b => rows.some(r => r.board === b));
  const players = opts.players || ORDER.filter(p => rows.some(r => r.player === p));
  const get = (b, p) => rows.find(r => r.board === b && r.player === p);
  const max = opts.max || Math.max(...rows.filter(r => players.includes(r.player)).map(r => (opts.ci ? r.ci_high : r[metric]) || 0)) * 1.15 || 1;
  const y = v => m.t + (H - m.t - m.b) * (1 - v / max);
  const gw = (W - m.l - m.r) / boards.length;
  const bw = Math.min(46, (gw - 50) / players.length - 4);
  let s = "";
  const ticks = opts.ticks || 5;
  for (let i = 0; i <= ticks; i++) {
    const v = max * i / ticks, yy = y(v);
    s += `<line class="gridline" x1="${m.l}" x2="${W - m.r}" y1="${yy}" y2="${yy}"/>`;
    s += `<text x="${m.l - 8}" y="${yy + 4}" text-anchor="end">${opts.fmt ? opts.fmt(v, true) : v.toFixed(1)}</text>`;
  }
  s += `<line class="axisline" x1="${m.l}" x2="${W - m.r}" y1="${y(0)}" y2="${y(0)}"/>`;
  boards.forEach((b, bi) => {
    const gx = m.l + gw * bi + (gw - players.length * (bw + 4)) / 2;
    s += `<text x="${m.l + gw * bi + gw / 2}" y="${H - 14}" text-anchor="middle" class="title">${BOARD_NAMES[b]}</text>`;
    players.forEach((p, pi) => {
      const r = get(b, p); if (!r) return;
      const v = r[metric] || 0, x = gx + pi * (bw + 4);
      const top = y(v), h = Math.max(0, y(0) - top);
      const rad = Math.min(4, h / 2);
      const tipText = `<b>${PLAYERS[p].label}</b> · ${BOARD_NAMES[b]}<br>${opts.tip ? opts.tip(r) : (opts.fmt ? opts.fmt(v) : v)}`;
      // bar with rounded top only (data end), anchored to the baseline
      s += `<path class="bar" d="M${x},${y(0)} V${top + rad} Q${x},${top} ${x + rad},${top} H${x + bw - rad} Q${x + bw},${top} ${x + bw},${top + rad} V${y(0)} Z" style="fill:${PLAYERS[p].color}" />`;
      s += `<rect x="${x - 2}" y="${m.t}" width="${bw + 4}" height="${y(0) - m.t}" fill="transparent" data-tip="${tipText.replace(/"/g, "&quot;")}"/>`;
      let labelY = top - 6;
      if (opts.ci) {
        const y1 = y(r.ci_low), y2 = y(r.ci_high), cx = x + bw / 2;
        s += `<line class="whisker" x1="${cx}" x2="${cx}" y1="${y1}" y2="${y2}"/><line class="whisker" x1="${cx - 5}" x2="${cx + 5}" y1="${y2}" y2="${y2}"/><line class="whisker" x1="${cx - 5}" x2="${cx + 5}" y1="${y1}" y2="${y1}"/>`;
        labelY = Math.min(top, y2) - 6;
      }
      s += `<text class="val" x="${x + bw / 2}" y="${labelY}" text-anchor="middle">${opts.fmt ? opts.fmt(v) : v.toFixed(2)}</text>`;
    });
  });
  svg.innerHTML = s;
}

function legendHTML(players) {
  return players.map(p => `<span><span class="swatch" style="--c:${PLAYERS[p].color}"></span>${PLAYERS[p].label}</span>`).join("");
}

function calChart(container, board, cal) {
  const W = 300, H = 290, m = { t: 30, r: 14, b: 42, l: 46 };
  const series = ["probability", "logic"].map(p => ({ p, pts: cal[`${board}/${p}`] || [] }));
  const maxV = Math.min(1, Math.max(0.5, ...series.flatMap(s => s.pts.flatMap(q => [q.predicted, q.observed]))) * 1.05);
  const x = v => m.l + (W - m.l - m.r) * v / maxV, y = v => m.t + (H - m.t - m.b) * (1 - v / maxV);
  let s = `<text x="${W / 2}" y="16" text-anchor="middle" class="title">${BOARD_NAMES[board]}</text>`;
  for (let i = 0; i <= 5; i++) {
    const v = maxV * i / 5;
    s += `<line class="gridline" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/>`;
    s += `<text x="${m.l - 6}" y="${y(v) + 4}" text-anchor="end">${Math.round(v * 100)}%</text>`;
    s += `<text x="${x(v)}" y="${H - m.b + 16}" text-anchor="middle">${Math.round(v * 100)}%</text>`;
  }
  s += `<line x1="${x(0)}" y1="${y(0)}" x2="${x(maxV)}" y2="${y(maxV)}" stroke="var(--axis)" stroke-dasharray="4 4" stroke-width="1.5"/>`;
  s += `<text x="${W / 2}" y="${H - 6}" text-anchor="middle">predicted P(mine)</text>`;
  s += `<text transform="translate(12,${(H - m.b + m.t) / 2}) rotate(-90)" text-anchor="middle">observed mine rate</text>`;
  series.forEach(({ p, pts }) => {
    if (!pts.length) return;
    s += `<polyline fill="none" stroke="${PLAYERS[p].color}" stroke-width="2" points="${pts.map(q => `${x(q.predicted)},${y(q.observed)}`).join(" ")}"/>`;
    pts.forEach(q => {
      const t = `<b>${PLAYERS[p].label}</b> · ${BOARD_NAMES[board]}<br>guesses rated ${Math.round(q.lo * 100)}–${Math.round(q.hi * 100)}%: <b>${q.n.toLocaleString()}</b><br>mean predicted ${pct(q.predicted)} · observed ${pct(q.observed)}`;
      s += `<circle cx="${x(q.predicted)}" cy="${y(q.observed)}" r="5" fill="${PLAYERS[p].color}" stroke="var(--surface)" stroke-width="2"/>`;
      s += `<circle cx="${x(q.predicted)}" cy="${y(q.observed)}" r="12" fill="transparent" data-tip="${t.replace(/"/g, "&quot;")}"/>`;
    });
  });
  container.innerHTML += `<div class="card" style="padding:12px"><svg class="chart" viewBox="0 0 ${W} ${H}">${s}</svg></div>`;
}

async function loadExperiments() {
  try {
    const [sum, cal] = await Promise.all([fetch("/results/summary.json").then(r => r.json()), fetch("/results/calibration.json").then(r => r.json())]);
    Exp.summary = sum; Exp.cal = cal;
  } catch (e) {
    $("#expMeta").textContent = "No results found. Run  python experiments.py  first.";
    return;
  }
  const S = Exp.summary, rows = S.summary;
  const get = (b, p) => rows.find(r => r.board === b && r.player === p);
  $("#expMeta").textContent = `${S.meta.games_per_cell.toLocaleString()} games per board per player (seeds ${S.meta.seeds}) · Python ${S.meta.python} · ${S.meta.platform} · run ${S.meta.date} · total ${Math.round(S.meta.total_seconds)} s`;

  // overview tiles
  $$("[data-stat]").forEach(el => {
    const [b, p, f] = el.dataset.stat.split("/");
    if (b === "meta") { el.textContent = `${S.meta.games_per_cell.toLocaleString()} games per board per player`; return; }
    const r = get(b, p); if (!r) return;
    if (f === "win_rate") el.textContent = pct(r.win_rate);
    else if (f === "ci") el.textContent = `95% CI ${pct(r.ci_low)} – ${pct(r.ci_high)} · logic only ${pct(get(b, "logic").win_rate)}`;
    else if (f === "ms_per_analysis") el.textContent = `${r.ms_per_analysis.toFixed(1)} ms`;
  });

  const draw = () => {
    $("#legendWin").innerHTML = legendHTML(ORDER);
    barChart($("#chartWin"), rows, "win_rate", { max: 1, ci: true, fmt: (v, axis) => axis ? `${Math.round(v * 100)}%` : pct(v),
      tip: r => `win rate <b>${pct(r.win_rate)}</b> (${r.wins.toLocaleString()} / ${r.games.toLocaleString()})<br>95% CI ${pct(r.ci_low)} – ${pct(r.ci_high)}` });
    barChart($("#chartGuess"), rows, "guesses_per_game", { height: 290, fmt: (v, axis) => axis ? v.toFixed(1) : v.toFixed(2),
      tip: r => `${r.guesses_per_game.toFixed(2)} guesses per game${r.guesses_per_won_game != null ? `<br>${r.guesses_per_won_game.toFixed(2)} per <i>won</i> game` : ""}${r.mean_guess_risk != null ? `<br>mean P(mine) of a guess: ${pct(r.mean_guess_risk)}` : ""}` });
    barChart($("#chartProgress"), rows, "revealed_fraction", { height: 290, max: 1, fmt: (v, axis) => axis ? `${Math.round(v * 100)}%` : pct(v, 0),
      tip: r => `on average ${pct(r.revealed_fraction)} of the safe squares revealed` });
    $("#legendCal").innerHTML = legendHTML(["probability", "logic"]) + `<span><svg width="26" height="10"><line x1="0" y1="5" x2="26" y2="5" stroke="var(--axis)" stroke-dasharray="4 4" stroke-width="1.5"/></svg>perfect calibration</span>`;
    $("#calCharts").innerHTML = "";
    ["beginner", "intermediate", "expert"].forEach(b => calChart($("#calCharts"), b, Exp.cal));
  };
  draw();
  window.__redrawCharts = draw;

  // paired table
  $("#pairedTable").innerHTML = `<tr><th>Board</th><th>A</th><th>B</th><th class="num">only A won</th><th class="num">only B won</th><th class="num">McNemar χ²</th><th>Significant?</th></tr>` +
    S.paired.map(p => `<tr><td>${BOARD_NAMES[p.board]}</td><td>${PLAYERS[p.a].label}</td><td>${PLAYERS[p.b].label}</td><td class="num">${p.only_a_won.toLocaleString()}</td><td class="num">${p.only_b_won.toLocaleString()}</td><td class="num">${p.mcnemar_chi2.toFixed(1)}</td><td>${p.mcnemar_chi2 > 10.83 ? "yes, p &lt; 0.001" : p.mcnemar_chi2 > 3.84 ? "yes, p &lt; 0.05" : "no"}</td></tr>`).join("");

  // full table
  $("#summaryTable").innerHTML = `<tr><th>Board</th><th>Player</th><th class="num">Win rate</th><th class="num">95% CI</th><th class="num">Guesses / game</th><th class="num">Mean P(mine) of guesses</th><th class="num">Safe squares revealed</th><th class="num">ms / move</th><th class="num">ms / analysis (mean · p95 · max)</th><th class="num">Largest component</th><th class="num">Budget hits</th></tr>` +
    rows.map(r => `<tr><td>${BOARD_NAMES[r.board]}</td><td><span class="swatch" style="--c:${PLAYERS[r.player].color}"></span> ${r.label}</td><td class="num"><b>${pct(r.win_rate)}</b></td><td class="num">${pct(r.ci_low)} – ${pct(r.ci_high)}</td><td class="num">${r.guesses_per_game.toFixed(2)}</td><td class="num">${r.mean_guess_risk != null && r.player !== "rules" ? pct(r.mean_guess_risk) : "–"}</td><td class="num">${pct(r.revealed_fraction)}</td><td class="num">${r.ms_per_move.toFixed(3)}</td><td class="num">${r.analyses ? `${r.ms_per_analysis.toFixed(2)} · ${r.ms_analysis_p95.toFixed(2)} · ${r.ms_analysis_max.toFixed(0)}` : "–"}</td><td class="num">${r.max_component || "–"}</td><td class="num">${r.player === "logic" || r.player === "probability" ? `${r.approx_analyses} / ${r.analyses.toLocaleString()}` : "–"}</td></tr>`).join("");

  // interpretation
  const g = (b, p) => get(b, p);
  const lift = b => ((g(b, "probability").win_rate - g(b, "logic").win_rate) * 100).toFixed(1);
  const calErr = b => {
    const pts = Exp.cal[`${b}/probability`] || [];
    const n = pts.reduce((s, q) => s + q.n, 0);
    return n ? pts.reduce((s, q) => s + q.n * Math.abs(q.predicted - q.observed), 0) / n : 0;
  };
  const BOARDS = ["beginner", "intermediate", "expert"];
  const d1 = b => (g(b, "logic").win_rate - g(b, "rules").win_rate) * 100;
  const d2 = b => (g(b, "probability").win_rate - g(b, "logic").win_rate) * 100;
  const pp = f => BOARDS.map(b => f(b).toFixed(1)).join(", ");
  $("#interpretation").innerHTML = `
    <p><b>1. Complete logic beats local rules on every board.</b> Logic only wins
    ${pct(g("beginner", "logic").win_rate)} / ${pct(g("intermediate", "logic").win_rate)} / ${pct(g("expert", "logic").win_rate)} against
    ${pct(g("beginner", "rules").win_rate)} / ${pct(g("intermediate", "rules").win_rate)} / ${pct(g("expert", "rules").win_rate)} for local rules
    (beginner / intermediate / expert). On identical boards the reverse is rare: local rules won a board that full logic lost only
    ${["beginner", "intermediate", "expert"].map(b => S.paired.find(p => p.board === b && p.a === "logic" && p.b === "rules").only_b_won).join(" / ")} times
    (paired table). Full logic proves a superset of what the rules prove, so those cases come down to the luck of the two players' random guesses.
    The gain is ${pp(d1)} percentage points (beginner, intermediate, expert): fewer forced guesses are needed when every entailed square is found
    (${g("expert", "logic").guesses_per_game.toFixed(2)} vs ${g("expert", "rules").guesses_per_game.toFixed(2)} guesses per game on expert).</p>
    <p><b>2. Probabilistic guessing adds a further ${pp(d2)} points.</b> Logic alone decides the same squares in both players, so the whole difference
    comes from <i>which</i> square is guessed when nothing is provable. The logic-only player's random forced guesses carry a mean P(mine) of
    ${BOARDS.map(b => pct(g(b, "logic").mean_guess_risk)).join(", ")}; the probability player's guesses carry
    ${BOARDS.map(b => pct(g(b, "probability").mean_guess_risk)).join(", ")}.
    ${BOARDS.filter(b => d2(b) > d1(b)).length ? `Probability is the larger of the two improvements on ${BOARDS.filter(b => d2(b) > d1(b)).map(b => BOARD_NAMES[b].toLowerCase()).join(" and ")}; complete logic is the larger on ${BOARDS.filter(b => d2(b) <= d1(b)).map(b => BOARD_NAMES[b].toLowerCase()).join(" and ") || "none"}.` : "Complete logic is the larger of the two improvements on every board."}</p>
    <p><b>3. The probabilities are calibrated.</b> In the calibration plots the probability player's points follow the diagonal: the
    weighted mean gap between predicted and observed mine rate is ${pct(calErr("beginner"))}, ${pct(calErr("intermediate"))} and
    ${pct(calErr("expert"))}. This is an empirical check, independent of the unit tests, that the C(U, R−k) weighting is right.</p>
    <p><b>4. Exact reasoning is fast enough.</b> The mean analysis takes ${g("expert", "probability").ms_per_analysis.toFixed(1)} ms on expert
    (95th percentile ${g("expert", "probability").ms_analysis_p95.toFixed(1)} ms). The worst case, ${Math.round(g("expert", "probability").ms_analysis_max)} ms,
    is a reminder that the problem is NP-hard in general: the largest frontier component reached ${g("expert", "probability").max_component} squares, and the search budget
    was exceeded in ${g("expert", "probability").approx_analyses} of ${g("expert", "probability").analyses.toLocaleString()} expert analyses (an approximation was used there).</p>
    <p><b>5. Why no player wins every game.</b> Some boards force a true 50/50 guess, so even a perfect player loses sometimes. Our player is also
    greedy: it minimises the risk of the next move only, not the probability of winning the whole game. Measured win rates should be read with that in mind,
    and against the rule that only the first click is guaranteed safe (variants that guarantee an opening 0 give higher numbers).</p>
    <p class="small muted"><b>Threats to validity.</b> Results depend on the first-click rule, the centre opening and our tie-break heuristic;
    timings depend on this machine and on Python. All boards come from Python's seeded random generator, so every number here is reproducible
    with <code>python experiments.py</code>.</p>`;
}

/* ================================================================== MAIN EXPERIMENT: one example */
const EX_PLAYERS = ["random", "rules", "logic", "probability"];   // in order of techniques added
const Example = {
  started: false, token: 0, games: {},
  ensure() {
    if (this.started) return;
    this.started = true;
    $("#exRun").onclick = () => this.run();
    $("#exRandom").onclick = () => { $("#exSeed").value = Math.floor(Math.random() * 3000); this.run(); };
    $("#exGrid").innerHTML = EX_PLAYERS.map(p => `
      <div class="card ex-card" style="--c:${PLAYERS[p].color}">
        <h3><span class="swatch"></span>${PLAYERS[p].label}<span class="status-badge ready" id="exSt-${p}" style="margin-left:auto">Ready</span></h3>
        <div class="board-wrap"><div class="board" id="exB-${p}"></div></div>
        <div class="ex-stats" id="exS-${p}">Press <b>Run this example</b>.</div>
      </div>`).join("");
  },
  size(cols) {
    const w = $("#exGrid .ex-card").clientWidth - 60;
    return Math.max(9, Math.min(34, Math.floor(w / cols) - 1));
  },
  async run() {
    const my = ++this.token;                        // cancels any example still running
    const board = $("#exBoard").value, seed = Number($("#exSeed").value) || 0;
    $("#exNote").textContent = "";
    $("#exGrid").classList.toggle("wide", board === "expert");
    try {
      const created = await Promise.all(EX_PLAYERS.map(p => api("/api/new", { board, agent: p, seed })));
      EX_PLAYERS.forEach((p, i) => { this.games[p] = { st: created[i].state, last: null, dec: null }; this.draw(p); });
      while (my === this.token && EX_PLAYERS.some(p => !this.over(p))) {
        await Promise.all(EX_PLAYERS.filter(p => !this.over(p)).map(async p => {
          const d = await api("/api/step", { id: this.games[p].st.id, explain: false });
          Object.assign(this.games[p], { st: d.state, last: d.decision && key(...d.decision.cell), dec: d.decision });
        }));
        if (my !== this.token) return;
        EX_PLAYERS.forEach(p => this.draw(p));
        const s = Number($("#exSpeed").value);
        await new Promise(r => setTimeout(r, Math.round(700 * Math.pow(1 - s / 100, 2)) + 10));
      }
      if (my === this.token) this.summarise(board, seed);
    } catch (err) { $("#exNote").innerHTML = `<span style="color:var(--critical)">${err.message}</span>`; }
  },
  over(p) { const g = this.games[p]; return g && (g.st.status === "won" || g.st.status === "lost"); },
  draw(p) {
    const g = this.games[p], st = g.st;
    renderBoard($(`#exB-${p}`), st, { size: this.size(st.cols), last: g.last });
    const b = $(`#exSt-${p}`);
    b.className = `status-badge ${st.status}`;
    b.textContent = { ready: "Ready", playing: "Playing", won: "Won 🎉", lost: "Lost 💥" }[st.status];
    const safeTotal = st.rows * st.cols - st.mines;
    const opened = st.view.flat().filter(v => v >= 0).length;
    $(`#exS-${p}`).innerHTML = `moves <b>${st.moves}</b> · guesses <b>${st.guesses}</b> · revealed <b>${Math.round(100 * opened / safeTotal)}%</b>` +
      (g.dec ? ` · last: <span class="reason ${g.dec.reason}">${REASON_TEXT[g.dec.reason]}</span>${g.dec.risk != null && g.dec.reason !== "proven-safe" ? ` P=${pct(g.dec.risk)}` : ""}` : "");
  },
  summarise(board, seed) {
    const won = EX_PLAYERS.filter(p => this.games[p].st.status === "won").map(p => PLAYERS[p].label);
    $("#exNote").innerHTML = `Game #${seed} on ${BOARD_NAMES[board].toLowerCase()}: ${won.length ? `<b>${won.join(", ")}</b> won` : "every player lost"}.
      In the experiment this board is played once by each player, and the same is done for seeds 0 to N−1; the win rate is the fraction of those games won.
      One board says little on its own (luck matters), which is exactly why the experiment uses thousands.`;
  },
};

/* ================================================================== MAIN EXPERIMENT: run it */
function summaryTableHTML(rows) {
  return `<tr><th>Board</th><th>Player</th><th class="num">Win rate</th><th class="num">95% CI</th><th class="num">Wins / games</th><th class="num">Guesses / game</th><th class="num">Mean P(mine) of guesses</th><th class="num">Safe squares revealed</th><th class="num">ms / analysis (mean · p95 · max)</th><th class="num">Largest component</th><th class="num">Budget hits</th></tr>` +
    rows.map(r => `<tr><td>${BOARD_NAMES[r.board]}</td><td><span class="swatch" style="--c:${PLAYERS[r.player].color}"></span> ${r.label}</td><td class="num"><b>${pct(r.win_rate)}</b></td><td class="num">${pct(r.ci_low)} – ${pct(r.ci_high)}</td><td class="num">${r.wins.toLocaleString()} / ${r.games.toLocaleString()}</td><td class="num">${r.guesses_per_game.toFixed(2)}</td><td class="num">${r.mean_guess_risk != null && r.player !== "rules" ? pct(r.mean_guess_risk) : "–"}</td><td class="num">${pct(r.revealed_fraction)}</td><td class="num">${r.analyses ? `${r.ms_per_analysis.toFixed(2)} · ${r.ms_analysis_p95.toFixed(2)} · ${r.ms_analysis_max.toFixed(0)}` : "–"}</td><td class="num">${r.max_component || "–"}</td><td class="num">${r.player === "logic" || r.player === "probability" ? `${r.approx_analyses} / ${r.analyses.toLocaleString()}` : "–"}</td></tr>`).join("");
}
function pairedTableHTML(paired) {
  return `<tr><th>Board</th><th>A</th><th>B</th><th class="num">only A won</th><th class="num">only B won</th><th class="num">McNemar χ²</th><th>Significant?</th></tr>` +
    paired.map(p => `<tr><td>${BOARD_NAMES[p.board]}</td><td>${PLAYERS[p.a].label}</td><td>${PLAYERS[p.b].label}</td><td class="num">${p.only_a_won.toLocaleString()}</td><td class="num">${p.only_b_won.toLocaleString()}</td><td class="num">${p.mcnemar_chi2.toFixed(1)}</td><td>${p.mcnemar_chi2 > 10.83 ? "yes, p &lt; 0.001" : p.mcnemar_chi2 > 3.84 ? "yes, p &lt; 0.05" : "no (not enough evidence)"}</td></tr>`).join("");
}

const Runner = {
  started: false, timer: null,
  ensure() {
    if (this.started) return;
    this.started = true;
    $("#runStart").onclick = () => this.start();
    $("#runCancel").onclick = () => api("/api/experiment/cancel");
    this.poll();                                     // pick up a run that is already going
  },
  async start() {
    const boards = $$(".runBoard:checked").map(x => x.value);
    const players = $$(".runPlayer:checked").map(x => x.value);
    try {
      await api("/api/experiment/start", { games: Number($("#runGames").value), boards, players });
      $("#runResults").innerHTML = "";
      this.poll();
    } catch (err) { $("#runProgress").innerHTML = `<p style="color:var(--critical)">${err.message}</p>`; }
  },
  async poll() {
    clearTimeout(this.timer);
    let s;
    try { s = await api("/api/experiment/status"); } catch (e) { return; }
    $("#runStart").disabled = !!s.running;
    $("#runCancel").disabled = !s.running;
    if (s.games) this.progress(s);
    if (s.running) { this.shown = null; this.timer = setTimeout(() => this.poll(), 400); }
    else if (s.result && this.shown !== s.folder) { this.shown = s.folder; this.results(s); }
  },
  progress(s) {
    const pr = s.progress || { overall_done: 0, overall_total: s.games * s.boards.length * s.players.length };
    const frac = pr.overall_total ? pr.overall_done / pr.overall_total : 0;
    const eta = frac > 0.02 && s.running ? Math.round(s.elapsed * (1 - frac) / frac) : null;
    const done = new Map(s.finished_cells.map(c => [`${c.board}/${c.player}`, c]));
    const cells = s.boards.flatMap(b => s.players.map(p => {
      const k = `${b}/${p}`, fin = done.get(k);
      const active = s.running && pr.board === b && pr.player === p;
      const n = fin ? fin.games : active ? pr.done : 0, w = fin ? fin.wins : active ? pr.wins : 0;
      return `<div class="run-cell ${fin ? "done" : active ? "active" : ""}">
        <div style="display:flex;justify-content:space-between;gap:6px"><span><span class="swatch" style="--c:${PLAYERS[p].color}"></span> ${BOARD_NAMES[b]} · ${PLAYERS[p].label}</span>
        <b>${n ? pct(w / n) : "–"}</b></div>
        <div class="progress"><div style="width:${(100 * n / s.games).toFixed(1)}%"></div></div>
        <div class="muted" style="font-size:.76rem;margin-top:3px">${fin ? `done · ${w} wins of ${n}` : active ? `playing game ${n} of ${s.games} · ${w} wins so far` : "waiting"}</div></div>`;
    })).join("");
    const state = s.running ? `Running… ${pr.overall_done.toLocaleString()} of ${pr.overall_total.toLocaleString()} games · ${Math.round(s.elapsed)} s elapsed${eta != null ? ` · about ${eta} s left` : ""}`
      : s.error === "cancelled" ? "Stopped." : s.error ? `<span style="color:var(--critical)">Error: ${s.error}</span>`
      : s.result ? `Finished ${pr.overall_total.toLocaleString()} games in ${Math.round(s.elapsed)} s.` : "";
    $("#runProgress").innerHTML = `<div style="margin:6px 0 6px;font-size:.92rem">${state}</div>
      <div class="progress"><div style="width:${(100 * frac).toFixed(1)}%"></div></div><div class="run-cells">${cells}</div>`;
  },
  async results(s) {
    const R = s.result, rows = R.summary, cal = R.calibration, f = s.folder;
    const hasCal = Object.values(cal).some(v => v.length);
    $("#runResults").innerHTML = `
      <h2>Results of your run</h2>
      <p class="small muted">${R.meta.games_per_cell.toLocaleString()} games per board per player (seeds ${R.meta.seeds}) · ${Math.round(R.meta.total_seconds)} s · saved in <code>${f}/</code></p>
      <div class="downloads">
        <a class="btn" href="/${f}/summary.json" download>⬇ summary.json</a>
        <a class="btn" href="/${f}/games.csv" download>⬇ games.csv (every game)</a>
        <a class="btn" href="/${f}/calibration.json" download>⬇ calibration.json</a>
      </div>
      <h3>Win rate</h3><div class="chart-legend">${legendHTML(ORDER.filter(p => rows.some(r => r.player === p)))}</div>
      <div class="card"><svg class="chart" id="rrWin"></svg></div>
      <p class="small muted">Whiskers: 95% Wilson interval. With fewer games the intervals are wider; compare with the 3,000-game results tab.</p>
      <div class="grid g2" style="margin-top:12px">
        <div><h3>Guesses per game</h3><div class="card"><svg class="chart" id="rrGuess"></svg></div></div>
        <div><h3>Safe squares revealed</h3><div class="card"><svg class="chart" id="rrProg"></svg></div></div>
      </div>
      ${hasCal ? `<h3>Calibration</h3><div class="chart-legend">${legendHTML(["probability", "logic"])}</div><div class="grid g3" id="rrCal"></div>` : ""}
      ${R.paired.length ? `<h3>Paired comparison on identical boards</h3><div class="table-wrap"><table>${pairedTableHTML(R.paired)}</table></div>` : ""}
      <h3>All numbers</h3><div class="table-wrap"><table>${summaryTableHTML(rows)}</table></div>
      <h3>Raw data: the first games of <code>games.csv</code></h3><div class="table-wrap" id="rrCsv"><p class="small muted" style="padding:8px">Loading…</p></div>`;
    barChart($("#rrWin"), rows, "win_rate", { max: 1, ci: true, fmt: (v, axis) => axis ? `${Math.round(v * 100)}%` : pct(v),
      tip: r => `win rate <b>${pct(r.win_rate)}</b> (${r.wins} / ${r.games})<br>95% CI ${pct(r.ci_low)} – ${pct(r.ci_high)}` });
    barChart($("#rrGuess"), rows, "guesses_per_game", { height: 290, fmt: (v, axis) => axis ? v.toFixed(1) : v.toFixed(2) });
    barChart($("#rrProg"), rows, "revealed_fraction", { height: 290, max: 1, fmt: (v, axis) => axis ? `${Math.round(v * 100)}%` : pct(v, 0) });
    if (hasCal) R.meta.boards_run.forEach(b => calChart($("#rrCal"), b, cal));
    try {
      const text = await fetch(`/${f}/games.csv`).then(r => r.text());
      const lines = text.trim().split(/\r?\n/), head = lines[0].split(",");
      const body = lines.slice(1, 31).map(l => `<tr>${l.split(",").map(c => `<td>${c}</td>`).join("")}</tr>`).join("");
      $("#rrCsv").innerHTML = `<table><tr>${head.map(h => `<th>${h}</th>`).join("")}</tr>${body}</table>
        <p class="small muted" style="padding:6px 10px">Showing 30 of ${(lines.length - 1).toLocaleString()} games. Download the CSV for all of them.</p>`;
    } catch (e) { $("#rrCsv").innerHTML = ""; }
    if (!$("#tab-experiment").classList.contains("active")) return;
    $("#runResults").scrollIntoView({ behavior: "smooth", block: "start" });
  },
};

/* ------------------------------------------------------------------ start */
showTab(location.hash.slice(1) || "overview");
loadExperiments();
