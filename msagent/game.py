"""Minesweeper environment.

The environment hides the mine layout from the agent. An agent only ever sees
``Game.view()``: for every cell either HIDDEN (-1) or the revealed number 0-8,
plus the total number of mines. This matches the partially observable
environment described in AIMA Ch. 2 and Ch. 4.4.

Rules used in this project (documented in the report):
* Standard sizes: beginner 9x9/10, intermediate 16x16/40, expert 16x30/99.
* The first click is always safe: mines are placed *after* the first click,
  never on the clicked cell (the classic Windows rule).
* Revealing a 0 automatically reveals all its neighbours (flood fill).
* The game is won when every non-mine cell is revealed.
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field

HIDDEN = -1

DIFFICULTIES = {
    "beginner": (9, 9, 10),        # (rows, cols, mines)
    "intermediate": (16, 16, 40),
    "expert": (16, 30, 99),
}

Cell = tuple[int, int]


def neighbours(cell: Cell, rows: int, cols: int) -> list[Cell]:
    """The up-to-8 cells around ``cell`` (the Minesweeper notion of adjacency)."""
    r, c = cell
    out = []
    for dr in (-1, 0, 1):
        for dc in (-1, 0, 1):
            if dr == 0 and dc == 0:
                continue
            rr, cc = r + dr, c + dc
            if 0 <= rr < rows and 0 <= cc < cols:
                out.append((rr, cc))
    return out


@dataclass
class Game:
    rows: int
    cols: int
    n_mines: int
    seed: int | None = None
    mines: set[Cell] = field(default_factory=set)
    revealed: dict[Cell, int] = field(default_factory=dict)
    status: str = "ready"          # ready -> playing -> won | lost
    exploded: Cell | None = None

    def __post_init__(self) -> None:
        if self.n_mines >= self.rows * self.cols:
            raise ValueError("too many mines for the board")
        self._rng = random.Random(self.seed)

    # ------------------------------------------------------------------ setup
    @classmethod
    def from_difficulty(cls, name: str, seed: int | None = None) -> "Game":
        rows, cols, mines = DIFFICULTIES[name]
        return cls(rows, cols, mines, seed)

    @classmethod
    def from_layout(cls, rows: int, cols: int, mines: set[Cell]) -> "Game":
        """Build a game with a fixed mine layout (used by tests and the walkthrough)."""
        g = cls(rows, cols, len(mines))
        g.mines = set(mines)
        g.status = "playing"
        return g

    def _place_mines(self, first: Cell) -> None:
        cells = [(r, c) for r in range(self.rows) for c in range(self.cols) if (r, c) != first]
        self.mines = set(self._rng.sample(cells, self.n_mines))
        self.status = "playing"

    # ---------------------------------------------------------------- actions
    def number(self, cell: Cell) -> int:
        return sum(1 for n in neighbours(cell, self.rows, self.cols) if n in self.mines)

    def reveal(self, cell: Cell) -> list[Cell]:
        """Reveal ``cell``. Returns the list of newly revealed cells.

        Revealing a mine ends the game (status 'lost')."""
        if self.status in ("won", "lost"):
            raise RuntimeError("game is over")
        if self.status == "ready":
            self._place_mines(cell)
        if cell in self.revealed:
            return []
        if cell in self.mines:
            self.status = "lost"
            self.exploded = cell
            return []
        newly: list[Cell] = []
        stack = [cell]
        while stack:                       # flood fill from zeros
            cur = stack.pop()
            if cur in self.revealed:
                continue
            n = self.number(cur)
            self.revealed[cur] = n
            newly.append(cur)
            if n == 0:
                stack.extend(x for x in neighbours(cur, self.rows, self.cols)
                             if x not in self.revealed)
        if len(self.revealed) == self.rows * self.cols - self.n_mines:
            self.status = "won"
        return newly

    # ------------------------------------------------------------- percepts
    def view(self) -> list[list[int]]:
        """What the agent is allowed to see: numbers for revealed cells, HIDDEN otherwise."""
        grid = [[HIDDEN] * self.cols for _ in range(self.rows)]
        for (r, c), n in self.revealed.items():
            grid[r][c] = n
        return grid

    @property
    def over(self) -> bool:
        return self.status in ("won", "lost")
