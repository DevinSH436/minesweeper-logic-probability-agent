"""Local web server for the project website and the live agent.

    python server.py            # then open http://127.0.0.1:8700
    python server.py --port 9000 --no-browser

Uses only the Python standard library. The browser never sees the mine layout
of a game in progress: the server holds the Game, and only returns the
percept (revealed numbers) plus the agent's reasoning.
"""

from __future__ import annotations

import argparse
import itertools
import json
import threading
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from msagent.agents import AGENTS, Decision
from msagent.game import DIFFICULTIES, Game
from msagent.solver import Analysis, Inconsistent, analyze

ROOT = Path(__file__).parent
WEB = ROOT / "web"
MAX_SESSIONS = 200

_sessions: dict[str, dict] = {}
_ids = itertools.count(1)
_lock = threading.Lock()


# ------------------------------------------------------------- serializers
def _cells(cells) -> list:
    return [list(c) for c in sorted(cells)]


def _num(x: int):
    """Big model counts are exact Python ints; send them as strings if JS can't hold them."""
    return x if abs(x) < 2**53 else str(x)


def ser_analysis(a: Analysis | None) -> dict | None:
    if a is None:
        return None
    return {
        "constraints": [{"src": list(c.source), "count": c.count, "cells": _cells(c.cells)}
                        for c in a.constraints],
        "rule_steps": [{"src": list(s["source"]), "count": s["count"], "kind": s["kind"],
                        "cells": _cells(s["cells"])} for s in a.rule_steps],
        "components": [{"cells": [list(x) for x in c.cells], "n_constraints": c.n_constraints,
                        "nodes": c.nodes, "exact": c.exact, "models": _num(c.n_models),
                        "models_by_k": {str(k): _num(v) for k, v in sorted(c.models_by_k.items())}}
                       for c in a.components],
        "safe": _cells(a.safe),
        "mines": _cells(a.mines),
        "probs": [[r, c, round(p, 6)] for (r, c), p in sorted(a.probs.items())],
        "interior": len(a.interior),
        "interior_prob": a.interior_prob,
        "remaining_mines": a.remaining_mines,
        "hidden": len(a.hidden),
        "exact": a.exact,
        "millis": round(a.millis, 3),
    }


def ser_state(s: dict) -> dict:
    g: Game = s["game"]
    out = {"id": s["id"], "rows": g.rows, "cols": g.cols, "mines": g.n_mines,
           "status": g.status, "view": g.view(), "agent": s["agent_name"],
           "moves": s["moves"], "guesses": s["guesses"], "think_ms": round(s["think_ms"], 3),
           "seed": s["seed"], "board": s["board"]}
    if g.over:                               # only reveal the layout once the game ends
        out["mine_cells"] = _cells(g.mines)
        out["exploded"] = list(g.exploded) if g.exploded else None
    return out


def ser_decision(d: Decision) -> dict:
    return {"cell": list(d.cell), "reason": d.reason, "risk": d.risk,
            "think_ms": round(d.think_ms, 3)}


# ---------------------------------------------------------------- actions
def new_game(p: dict) -> dict:
    board = p.get("board", "beginner")
    if board in DIFFICULTIES:
        rows, cols, mines = DIFFICULTIES[board]
    else:
        rows = max(4, min(30, int(p.get("rows", 9))))
        cols = max(4, min(40, int(p.get("cols", 9))))
        mines = max(1, min(rows * cols - 10, int(p.get("mines", 10))))
        board = "custom"
    seed = p.get("seed")
    seed = int(seed) if seed not in (None, "") else None
    agent_name = p.get("agent", "probability")
    if agent_name not in AGENTS:
        raise ValueError(f"unknown agent {agent_name}")
    sid = str(next(_ids))
    s = {"id": sid, "game": Game(rows, cols, mines, seed), "agent": AGENTS[agent_name](seed),
         "agent_name": agent_name, "moves": 0, "guesses": 0, "think_ms": 0.0,
         "seed": seed, "board": board}
    _sessions[sid] = s
    while len(_sessions) > MAX_SESSIONS:
        _sessions.pop(next(iter(_sessions)))
    return {"state": ser_state(s), "analysis": ser_analysis(analyze(s["game"].view(), mines))}


def _session(p: dict) -> dict:
    s = _sessions.get(str(p.get("id")))
    if s is None:
        raise KeyError("game not found (the server may have restarted) - start a new game")
    return s


def step(p: dict) -> dict:
    """The agent makes one move.  With fresh=True the agent re-runs its full
    reasoning even for cells it already proved safe, so the explainer can show
    every stage for every move."""
    s = _session(p)
    g: Game = s["game"]
    if g.over:
        return {"state": ser_state(s), "decision": None, "analysis": None}
    agent = s["agent"]
    if p.get("fresh"):
        agent.pending.clear()
    first = g.status == "ready"
    view = g.view()
    d = agent.choose(view, g.n_mines, first)
    before = d.analysis
    if before is None and p.get("explain", True) and not first:
        before = analyze(view, g.n_mines, use_enumeration=s["agent_name"] != "rules")
    newly = g.reveal(d.cell)
    s["moves"] += 1
    s["think_ms"] += d.think_ms
    if d.reason not in ("opening", "proven-safe"):
        s["guesses"] += 1
    after = analyze(g.view(), g.n_mines) if (p.get("explain", True) and not g.over) else None
    return {"state": ser_state(s), "decision": ser_decision(d), "newly": _cells(newly),
            "analysis_before": ser_analysis(before), "analysis": ser_analysis(after)}


def human_reveal(p: dict) -> dict:
    s = _session(p)
    g: Game = s["game"]
    if g.over:
        return {"state": ser_state(s), "analysis": None}
    cell = tuple(p["cell"])
    newly = g.reveal(cell)
    s["moves"] += 1
    after = analyze(g.view(), g.n_mines) if not g.over else None
    return {"state": ser_state(s), "newly": _cells(newly), "analysis": ser_analysis(after)}


def do_analyze(p: dict) -> dict:
    s = _session(p)
    g: Game = s["game"]
    return {"analysis": None if g.over else ser_analysis(analyze(g.view(), g.n_mines))}


# ------------------------------------------------- run the experiment from the site
_job: dict = {"running": False}
_job_lock = threading.Lock()


def exp_start(p: dict) -> dict:
    """Start experiments.run() in a background thread.  Results of runs started
    from the website go to results/runs/<timestamp>/ so they never overwrite the
    official results in results/."""
    import time
    import experiments
    with _job_lock:
        if _job.get("running"):
            raise ValueError("an experiment is already running")
        games = max(1, min(5000, int(p.get("games", 100))))
        boards = [b for b in p.get("boards", list(DIFFICULTIES)) if b in DIFFICULTIES]
        players = [x for x in p.get("players", list(AGENTS)) if x in AGENTS]
        if not boards or not players:
            raise ValueError("choose at least one board and one player")
        stamp = time.strftime("%Y%m%d-%H%M%S")
        out = ROOT / "results" / "runs" / stamp
        _job.clear()
        _job.update({"running": True, "cancel": False, "games": games, "boards": boards,
                     "players": players, "started": time.time(), "progress": None,
                     "finished_cells": [], "result": None, "error": None,
                     "folder": f"results/runs/{stamp}"})

    def progress(ev):
        _job["progress"] = ev
        if ev["done"] == ev["of"]:
            _job["finished_cells"].append({"board": ev["board"], "player": ev["player"],
                                           "wins": ev["wins"], "games": ev["of"]})

    def work():
        try:
            res = experiments.run(games, boards, players, out=out, progress=progress,
                                  cancel=lambda: _job.get("cancel"), quiet=True)
            _job["result"] = res
        except experiments.Cancelled:
            _job["error"] = "cancelled"
            import shutil
            shutil.rmtree(out, ignore_errors=True)       # nothing was written yet
        except Exception as e:                       # report, don't crash the server
            _job["error"] = f"{type(e).__name__}: {e}"
        finally:
            _job["running"] = False
            _job["elapsed"] = time.time() - _job["started"]

    threading.Thread(target=work, daemon=True).start()
    return exp_status({})


def exp_status(p: dict) -> dict:
    import time
    j = {k: v for k, v in _job.items() if k != "cancel"}
    if j.get("running"):
        j["elapsed"] = time.time() - j["started"]
    return j


def exp_cancel(p: dict) -> dict:
    _job["cancel"] = True
    return exp_status({})


ROUTES = {"/api/new": new_game, "/api/step": step, "/api/reveal": human_reveal,
          "/api/analyze": do_analyze, "/api/experiment/start": exp_start,
          "/api/experiment/status": exp_status, "/api/experiment/cancel": exp_cancel}
NO_LOCK = {"/api/experiment/status", "/api/experiment/cancel", "/api/experiment/start"}


# ----------------------------------------------------------------- server
class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def log_message(self, fmt, *args):       # keep the console quiet
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            self.path = "/web/index.html"
        if not (self.path.startswith("/web/") or self.path.startswith("/results/")):
            self.send_error(404)
            return
        super().do_GET()

    def do_POST(self):
        fn = ROUTES.get(self.path)
        if fn is None:
            self.send_error(404)
            return
        try:
            n = int(self.headers.get("Content-Length", 0))
            payload = json.loads(self.rfile.read(n) or b"{}")
            if self.path in NO_LOCK:
                body, code = fn(payload), 200
            else:
                with _lock:
                    body, code = fn(payload), 200
        except (KeyError, ValueError, Inconsistent) as e:
            body, code = {"error": str(e)}, 400
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8700)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()
    httpd = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    url = f"http://127.0.0.1:{args.port}/"
    print(f"Minesweeper agent site running at {url}  (Ctrl+C to stop)", flush=True)
    if not args.no_browser:
        webbrowser.open(url)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
