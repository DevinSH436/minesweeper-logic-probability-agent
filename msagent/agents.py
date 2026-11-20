"""The players compared in the experiments (agent types from AIMA Ch. 2).

* RandomAgent      - simple reflex agent with a random policy; ignores percepts.
* RulesAgent       - model-based agent using only the two single-number rules
                     (sound but incomplete inference); guesses at random when stuck.
* LogicAgent       - model-based, goal-based knowledge-based agent (Ch. 7):
                     reveals only cells it can *prove* safe by model checking;
                     when nothing is entailed it must make a forced random guess,
                     like the hybrid Wumpus agent's "take a risk" branch.
* ProbabilityAgent - model-based, utility-based agent (Ch. 7 + Ch. 12):
                     same logic first; when nothing is entailed it reveals the
                     cell with the lowest P(mine), i.e. the action with maximum
                     expected utility when utility = survive this move.

Every agent sees only the percept (``game.view()``) and the mine total.
"""

from __future__ import annotations

import random
import time
from dataclasses import dataclass, field

from .game import HIDDEN, Cell, Game, neighbours
from .solver import Analysis, analyze

PROB_EPS = 1e-12


@dataclass
class Decision:
    cell: Cell
    reason: str            # opening | proven-safe | min-probability | forced-guess | random
    risk: float | None     # agent's belief P(mine) for the chosen cell, if it has one
    think_ms: float
    analysis: Analysis | None = None


def hidden_cells(view) -> list[Cell]:
    return [(r, c) for r, row in enumerate(view) for c, v in enumerate(row) if v == HIDDEN]


def opening_cell(view) -> Cell:
    """All reasoning agents open the centre cell (the first click is always safe)."""
    return (len(view) // 2, len(view[0]) // 2)


class Agent:
    name = "agent"
    label = "Agent"

    def __init__(self, seed: int | None = None):
        # The agent's random stream must be independent of the board's: if both
        # used random.Random(seed), the agent's "random" guesses would replay the
        # draws that placed the mines and land on mines far too often.
        self.rng = random.Random(None if seed is None else f"agent:{seed}")
        self.pending: set[Cell] = set()     # proven-safe cells not yet revealed
        self.known_mines: set[Cell] = set()

    def reset(self) -> None:
        self.pending.clear()
        self.known_mines.clear()

    def choose(self, view, total_mines: int, first: bool) -> Decision:
        raise NotImplementedError

    # Knowledge only grows (AIMA 7.3: "monotonicity"), so cells proven safe stay
    # safe after other reveals; reveal them without re-running inference.
    def _from_pending(self, view) -> Decision | None:
        self.pending = {x for x in self.pending if view[x[0]][x[1]] == HIDDEN}
        if self.pending:
            cell = min(self.pending)
            self.pending.discard(cell)
            return Decision(cell, "proven-safe", 0.0, 0.0)
        return None


class RandomAgent(Agent):
    name, label = "random", "Random"

    def choose(self, view, total_mines, first):
        t0 = time.perf_counter()
        cell = self.rng.choice(hidden_cells(view))
        return Decision(cell, "opening" if first else "random", None,
                        (time.perf_counter() - t0) * 1000)


class _Reasoner(Agent):
    use_enumeration = True

    def think(self, view, total_mines) -> Analysis:
        a = analyze(view, total_mines, use_enumeration=self.use_enumeration)
        self.known_mines = set(a.mines)
        self.pending = set(a.safe)
        return a

    def choose(self, view, total_mines, first):
        if first:
            return Decision(opening_cell(view), "opening", None, 0.0)
        d = self._from_pending(view)
        if d:
            return d
        t0 = time.perf_counter()
        a = self.think(view, total_mines)
        if self.pending:
            cell = min(self.pending)
            self.pending.discard(cell)
            return Decision(cell, "proven-safe", 0.0, (time.perf_counter() - t0) * 1000, a)
        cell, risk, reason = self.when_stuck(view, a)
        return Decision(cell, reason, risk, (time.perf_counter() - t0) * 1000, a)

    def when_stuck(self, view, a: Analysis):
        options = [x for x in hidden_cells(view) if x not in a.mines]
        cell = self.rng.choice(options)
        return cell, a.probs.get(cell), "forced-guess"


class RulesAgent(_Reasoner):
    name, label = "rules", "Local rules"
    use_enumeration = False


class LogicAgent(_Reasoner):
    name, label = "logic", "Logic only"


class ProbabilityAgent(_Reasoner):
    name, label = "probability", "Logic + probability"

    def when_stuck(self, view, a: Analysis):
        rows, cols = len(view), len(view[0])
        options = [x for x in hidden_cells(view) if x not in a.mines]
        best = min(a.probs[x] for x in options)
        tied = [x for x in options if a.probs[x] <= best + PROB_EPS]

        # Tie-break (a heuristic, not from the book): prefer cells with fewer
        # hidden neighbours (corners/edges), which are likelier to be a 0 and
        # open up more of the board.
        def hidden_nbrs(x):
            return sum(1 for y in neighbours(x, rows, cols) if view[y[0]][y[1]] == HIDDEN)

        fewest = min(hidden_nbrs(x) for x in tied)
        tied = [x for x in tied if hidden_nbrs(x) == fewest]
        cell = self.rng.choice(sorted(tied))
        return cell, a.probs[cell], "min-probability"


AGENTS = {cls.name: cls for cls in (RandomAgent, RulesAgent, LogicAgent, ProbabilityAgent)}


@dataclass
class GameResult:
    won: bool
    moves: int = 0             # cells the agent chose to reveal
    guesses: int = 0           # moves not proven safe (excluding the opening)
    guess_risk: float = 0.0    # sum of the agent's P(mine) over its guesses
    think_ms: float = 0.0
    analyses: int = 0
    approx: int = 0            # analyses where a component exceeded the budget
    max_component: int = 0
    revealed_fraction: float = 0.0
    death_reason: str | None = None
    analysis_ms: list = field(default_factory=list)
    guess_records: list = field(default_factory=list)   # (predicted P(mine), died)
    log: list = field(default_factory=list)


def play(game: Game, agent: Agent, keep_log: bool = False) -> GameResult:
    """Play one full game and collect the metrics used in the experiments."""
    agent.reset()
    res = GameResult(won=False)
    first = True
    while not game.over:
        view = game.view()
        d = agent.choose(view, game.n_mines, first)
        res.moves += 1
        res.think_ms += d.think_ms
        if d.analysis is not None:
            res.analyses += 1
            res.analysis_ms.append(d.analysis.millis)
            if any(not c.exact for c in d.analysis.components):
                res.approx += 1
            if d.analysis.components:
                res.max_component = max(res.max_component,
                                        max(len(c.cells) for c in d.analysis.components))
        guess = d.reason not in ("opening", "proven-safe")
        if guess:
            res.guesses += 1
            res.guess_risk += d.risk or 0.0
        if keep_log:
            res.log.append((d.cell, d.reason, d.risk))
        game.reveal(d.cell)
        if guess and d.risk is not None:
            res.guess_records.append((d.risk, game.status == "lost"))
        if game.status == "lost":
            res.death_reason = d.reason
        first = False
    res.won = game.status == "won"
    safe_total = game.rows * game.cols - game.n_mines
    res.revealed_fraction = len(game.revealed) / safe_total
    return res
