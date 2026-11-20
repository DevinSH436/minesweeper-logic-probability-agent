"""Run the main experiment: every player on every board size.

    python experiments.py                 # default: 3000 games per board per player
    python experiments.py --games 200     # quick run

Seeds 0..N-1 are shared by all players, so every player that opens in the centre
faces exactly the same boards (a paired comparison). Results go to results/:
  summary.json      - one row per (board, player) with all metrics
  games.csv         - one row per game
  calibration.json  - predicted P(mine) of guesses vs. how often they hit a mine
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import platform
import statistics
import sys
import time
from pathlib import Path

from msagent.agents import AGENTS, play
from msagent.game import DIFFICULTIES, Game

OUT = Path(__file__).parent / "results"
PLAYERS = ["random", "rules", "logic", "probability"]
BINS = [0.0, 0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.40, 0.50, 1.0001]


def wilson(wins: int, n: int, z: float = 1.96) -> tuple[float, float]:
    """95% Wilson score interval for a win rate."""
    if n == 0:
        return 0.0, 0.0
    p = wins / n
    d = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / d
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return max(0.0, centre - half), min(1.0, centre + half)


class Cancelled(Exception):
    pass


def run(n_games: int, boards=None, players=None, out: Path = OUT,
        progress=None, cancel=None, quiet: bool = False) -> dict:
    """Run the experiment and write summary.json, calibration.json and games.csv to ``out``.

    ``progress(event)`` is called after every game (used by the website to show
    live progress); ``cancel()`` returning True stops the run."""
    boards = [b for b in DIFFICULTIES if boards is None or b in boards]
    players = [p for p in PLAYERS if players is None or p in players]
    out.mkdir(parents=True, exist_ok=True)
    summary, rows, calibration = [], [], {}
    won_by = {}                                   # (board, player) -> list[bool]
    t_all = time.perf_counter()
    total_games = n_games * len(boards) * len(players)
    done_games = 0
    for board in boards:
        for player in players:
            t0 = time.perf_counter()
            results = []
            wins_so_far = 0
            for seed in range(n_games):
                if cancel and cancel():
                    raise Cancelled
                res = play(Game.from_difficulty(board, seed), AGENTS[player](seed))
                wins_so_far += res.won
                done_games += 1
                if progress:
                    progress({"board": board, "player": player, "done": seed + 1, "of": n_games,
                              "wins": wins_so_far, "overall_done": done_games,
                              "overall_total": total_games})
                results.append(res)
                rows.append({"board": board, "player": player, "seed": seed,
                             "won": int(res.won), "moves": res.moves, "guesses": res.guesses,
                             "revealed_fraction": round(res.revealed_fraction, 4),
                             "think_ms": round(res.think_ms, 3), "analyses": res.analyses,
                             "approx": res.approx, "max_component": res.max_component,
                             "death_reason": res.death_reason or ""})
            wins = sum(r.won for r in results)
            lo, hi = wilson(wins, n_games)
            moves = sum(r.moves for r in results)
            a_ms = [m for r in results for m in r.analysis_ms]
            recs = [g for r in results for g in r.guess_records]
            deaths = {}
            for r in results:
                if r.death_reason:
                    deaths[r.death_reason] = deaths.get(r.death_reason, 0) + 1
            won_by[(board, player)] = [r.won for r in results]
            row = {
                "board": board, "player": player, "label": AGENTS[player].label,
                "games": n_games, "wins": wins, "win_rate": wins / n_games,
                "ci_low": lo, "ci_high": hi,
                "guesses_per_game": statistics.mean(r.guesses for r in results),
                "guesses_per_won_game": (statistics.mean(r.guesses for r in results if r.won)
                                         if wins else None),
                "revealed_fraction": statistics.mean(r.revealed_fraction for r in results),
                "ms_per_move": sum(r.think_ms for r in results) / moves,
                "ms_per_analysis": statistics.mean(a_ms) if a_ms else 0.0,
                "ms_analysis_p95": (sorted(a_ms)[int(0.95 * (len(a_ms) - 1))] if a_ms else 0.0),
                "ms_analysis_max": max(a_ms) if a_ms else 0.0,
                "analyses": len(a_ms),
                "approx_analyses": sum(r.approx for r in results),
                "max_component": max(r.max_component for r in results),
                "mean_guess_risk": (statistics.mean(p for p, _ in recs) if recs else None),
                "deaths_by_reason": deaths,
                "seconds": time.perf_counter() - t0,
            }
            summary.append(row)
            if player in ("logic", "probability"):
                cal = []
                for lo_b, hi_b in zip(BINS, BINS[1:]):
                    b = [(p, d) for p, d in recs if lo_b <= p < hi_b]
                    if b:
                        cal.append({"lo": lo_b, "hi": min(hi_b, 1.0), "n": len(b),
                                    "predicted": statistics.mean(p for p, _ in b),
                                    "observed": sum(d for _, d in b) / len(b)})
                calibration[f"{board}/{player}"] = cal
            if not quiet:
                print(f"{board:12} {player:12} win {wins/n_games:6.1%} [{lo:.1%}, {hi:.1%}]  "
                      f"guesses {row['guesses_per_game']:.2f}  {row['ms_per_move']:.2f} ms/move  "
                      f"({row['seconds']:.1f}s)", flush=True)

    # Paired comparison on identical boards (centre-opening players).
    paired = []
    for board in boards:
        for a, b in (("probability", "logic"), ("logic", "rules"), ("probability", "rules")):
            if (board, a) not in won_by or (board, b) not in won_by:
                continue
            wa, wb = won_by[(board, a)], won_by[(board, b)]
            only_a = sum(1 for x, y in zip(wa, wb) if x and not y)
            only_b = sum(1 for x, y in zip(wa, wb) if y and not x)
            # McNemar's test (normal approximation with continuity correction)
            chi2 = ((abs(only_a - only_b) - 1) ** 2 / (only_a + only_b)) if only_a + only_b else 0.0
            paired.append({"board": board, "a": a, "b": b, "only_a_won": only_a,
                           "only_b_won": only_b, "mcnemar_chi2": chi2})

    meta = {"games_per_cell": n_games, "seeds": f"0..{n_games - 1}",
            "python": sys.version.split()[0], "platform": platform.platform(),
            "processor": platform.processor(),
            "boards": {k: {"rows": v[0], "cols": v[1], "mines": v[2]} for k, v in DIFFICULTIES.items()},
            "total_seconds": time.perf_counter() - t_all,
            "date": time.strftime("%Y-%m-%d %H:%M"),
            "boards_run": boards, "players_run": players}
    result = {"meta": meta, "summary": summary, "paired": paired}
    (out / "summary.json").write_text(json.dumps(result, indent=2))
    (out / "calibration.json").write_text(json.dumps(calibration, indent=2))
    with open(out / "games.csv", "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)
    if not quiet:
        print(f"done in {meta['total_seconds']:.0f}s -> {out}")
    return {**result, "calibration": calibration}


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--games", type=int, default=3000, help="games per board per player")
    run(ap.parse_args().games)
