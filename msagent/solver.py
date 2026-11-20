"""Reasoning engine: logic (AIMA Ch. 7) and probability (AIMA Ch. 12).

Knowledge base
--------------
For every hidden cell x there is a proposition symbol M_x ("x holds a mine").
Every revealed number n at cell c contributes the sentence

    exactly n of { M_y : y hidden neighbour of c } are true

and the game tells us the total number of mines, which contributes

    exactly TOTAL of { M_x : x hidden } are true.

This is the Minesweeper version of the Wumpus World knowledge base: a number
plays the role of a breeze, and mines play the role of pits (AIMA 7.2, 7.4.3).

Inference (Ch. 7)
-----------------
A cell x is *safe* iff KB |= not M_x, i.e. iff no model of the KB has a mine
on x (entailment = truth in all models, AIMA 7.3).  We decide this by model
checking, as TT-ENTAILS does, but we only enumerate the symbols the numbers
actually mention (the "frontier"), split into independent components, and
prune any partial assignment that already violates a number.  Cheap
single-clue rules (a form of unit propagation, AIMA 7.6) run first.

Probability (Ch. 12)
--------------------
When nothing is entailed, the same enumeration gives exact probabilities, as
in the Wumpus pit calculation of AIMA 12.7: every layout consistent with the
evidence is equally likely, so

    P(M_x | evidence) = (# consistent layouts with a mine on x) / (# consistent layouts).

Cells off the frontier ("interior" cells, AIMA's "other" squares) are not
enumerated one by one.  A frontier assignment using k mines can be completed
in C(U, R - k) ways, where U is the number of interior cells and R the number
of mines not yet accounted for, so each frontier layout is weighted by that
binomial coefficient.  All arithmetic is done with exact Python integers.
"""

from __future__ import annotations

import sys
import time
from dataclasses import dataclass, field
from math import comb

from .game import HIDDEN, Cell, neighbours

sys.setrecursionlimit(20000)

DEFAULT_NODE_BUDGET = 400_000     # search nodes per component before we approximate


@dataclass
class Constraint:
    """One revealed number: ``count`` mines among ``cells`` (its hidden neighbours)."""
    source: Cell
    cells: frozenset
    count: int


@dataclass
class Component:
    cells: list                      # frontier cells in this independent group
    n_constraints: int
    nodes: int = 0                   # search nodes used by the model checker
    exact: bool = True
    models_by_k: dict = field(default_factory=dict)   # k mines -> number of models
    mine_counts: dict = field(default_factory=dict)   # k -> per-cell count of models with a mine

    @property
    def n_models(self) -> int:
        return sum(self.models_by_k.values())


@dataclass
class Analysis:
    """Everything the agent concluded from one percept, kept for the explainer UI."""
    rows: int
    cols: int
    total_mines: int
    hidden: set
    constraints: list
    rule_steps: list                 # single-clue deductions, in order
    components: list
    safe: set                        # entailed safe cells   (KB |= not M_x)
    mines: set                       # entailed mine cells   (KB |= M_x)
    probs: dict                      # P(mine) for every hidden cell
    interior: list                   # hidden cells not touched by any number
    interior_prob: float | None
    remaining_mines: int             # R: mines not proven, still to place
    exact: bool
    millis: float

    @property
    def frontier(self) -> list:
        return [c for comp in self.components for c in comp.cells]


class Inconsistent(Exception):
    """The percepts contradict each other (should never happen in a real game)."""


class _BudgetExceeded(Exception):
    pass


# --------------------------------------------------------------------------- KB
def build_constraints(view: list[list[int]]) -> tuple[set, list[Constraint]]:
    rows, cols = len(view), len(view[0])
    hidden = {(r, c) for r in range(rows) for c in range(cols) if view[r][c] == HIDDEN}
    cons = []
    for r in range(rows):
        for c in range(cols):
            n = view[r][c]
            if n == HIDDEN:
                continue
            hn = frozenset(x for x in neighbours((r, c), rows, cols) if x in hidden)
            if hn:
                cons.append(Constraint((r, c), hn, n))
    return hidden, cons


def single_clue_rules(constraints, safe: set, mines: set, steps: list | None = None) -> None:
    """Apply the two classic single-number rules until nothing changes.

    * if a number already touches as many proven mines as it shows, its other
      hidden neighbours are safe;
    * if its unknown neighbours are exactly as many as its missing mines, they
      are all mines.
    Both are sound inferences from one sentence of the KB (like Modus Ponens on
    a single clause); on their own they are *incomplete*.  ``safe`` and
    ``mines`` are updated in place.
    """
    changed = True
    while changed:
        changed = False
        for con in constraints:
            unknown = [x for x in con.cells if x not in safe and x not in mines]
            if not unknown:
                continue
            missing = con.count - sum(1 for x in con.cells if x in mines)
            if missing < 0 or missing > len(unknown):
                raise Inconsistent(f"number at {con.source} cannot be satisfied")
            if missing == 0:
                safe.update(unknown)
                kind = "safe"
            elif missing == len(unknown):
                mines.update(unknown)
                kind = "mine"
            else:
                continue
            changed = True
            if steps is not None:
                steps.append({"source": con.source, "count": con.count,
                              "kind": kind, "cells": sorted(unknown)})


# ----------------------------------------------------------- model checking
def _components(cons):
    """Split the frontier into groups that share no number (independent sub-KBs)."""
    parent = {}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for cells, _ in cons:
        for x in cells:
            parent.setdefault(x, x)
        first = next(iter(cells))
        for x in cells:
            ra, rb = find(first), find(x)
            if ra != rb:
                parent[rb] = ra
    groups: dict = {}
    for cells, cnt in cons:
        groups.setdefault(find(next(iter(cells))), []).append((cells, cnt))
    return list(groups.values())


def _order(cells_cons):
    """Variable order: walk the constraint graph breadth-first so that numbers
    become fully assigned early and bad partial assignments are pruned early."""
    adj: dict = {}
    for cells, _ in cells_cons:
        for x in cells:
            adj.setdefault(x, set()).update(cells)
    start = min(adj)
    seen, order, queue = {start}, [], [start]
    while queue:
        x = queue.pop(0)
        order.append(x)
        for y in sorted(adj[x]):
            if y not in seen:
                seen.add(y)
                queue.append(y)
    for x in sorted(adj):            # (graph is connected, but be safe)
        if x not in seen:
            order.append(x)
    return order


def check_models(cells_cons, budget: int = DEFAULT_NODE_BUDGET) -> Component:
    """Enumerate every assignment of the component's symbols that satisfies all
    its numbers (backtracking model checking with pruning).

    Records, for each possible number of mines k in the component, how many
    models there are and in how many of them each cell holds a mine."""
    order = _order(cells_cons)
    idx = {x: i for i, x in enumerate(order)}
    n = len(order)
    need = [cnt for _, cnt in cells_cons]          # mines still needed per number
    rem = [len(cells) for cells, _ in cells_cons]  # unassigned symbols per number
    var_cons = [[] for _ in range(n)]
    for ci, (cells, _) in enumerate(cells_cons):
        for x in cells:
            var_cons[idx[x]].append(ci)

    comp = Component(cells=order, n_constraints=len(cells_cons))
    assign = [0] * n
    nodes = 0

    def bt(i: int, k: int) -> None:
        nonlocal nodes
        nodes += 1
        if nodes > budget:
            raise _BudgetExceeded
        if i == n:
            comp.models_by_k[k] = comp.models_by_k.get(k, 0) + 1
            counts = comp.mine_counts.setdefault(k, [0] * n)
            for j in range(n):
                if assign[j]:
                    counts[j] += 1
            return
        for val in (0, 1):
            ok = True
            for ci in var_cons[i]:
                rem[ci] -= 1
                need[ci] -= val
                if need[ci] < 0 or need[ci] > rem[ci]:
                    ok = False
            if ok:
                assign[i] = val
                bt(i + 1, k + val)
                assign[i] = 0
            for ci in var_cons[i]:
                rem[ci] += 1
                need[ci] += val

    try:
        bt(0, 0)
    except _BudgetExceeded:
        comp.exact = False
        comp.models_by_k, comp.mine_counts = {}, {}
    comp.nodes = nodes
    return comp


# ------------------------------------------------------------ probability
def _conv(a: list, b: list) -> list:
    out = [0] * (len(a) + len(b) - 1)
    for i, x in enumerate(a):
        if x:
            for j, y in enumerate(b):
                if y:
                    out[i + j] += x * y
    return out


def _poly(comp: Component) -> list:
    if not comp.models_by_k:
        return [1]
    p = [0] * (max(comp.models_by_k) + 1)
    for k, v in comp.models_by_k.items():
        p[k] = v
    return p


def _approximate(comp: Component, cells_cons) -> None:
    """Fallback when a component is too large to enumerate within budget:
    give each cell the average local density of its numbers and pretend the
    component holds that many mines.  Never used for logical conclusions."""
    dens: dict = {}
    for cells, cnt in cells_cons:
        for x in cells:
            dens.setdefault(x, []).append(cnt / len(cells))
    probs = [sum(dens[x]) / len(dens[x]) for x in comp.cells]
    k = round(sum(probs))
    comp.models_by_k = {k: 1}
    comp.approx_probs = probs


def analyze(view: list[list[int]], total_mines: int,
            budget: int = DEFAULT_NODE_BUDGET, use_enumeration: bool = True) -> Analysis:
    """Run the full reasoning pipeline on one percept.

    ``use_enumeration=False`` stops after the single-clue rules (this is what
    the 'local rules' baseline player uses)."""
    t0 = time.perf_counter()
    rows, cols = len(view), len(view[0])
    hidden, constraints = build_constraints(view)

    # Stage 1: cheap single-clue rules.
    safe: set = set()
    mines: set = set()
    steps: list = []
    single_clue_rules(constraints, safe, mines, steps)

    # Remaining (reduced) sentences over still-unknown symbols.
    reduced = []
    for con in constraints:
        unknown = frozenset(x for x in con.cells if x not in safe and x not in mines)
        if unknown:
            reduced.append((unknown, con.count - sum(1 for x in con.cells if x in mines)))

    frontier_cells = set().union(*[c for c, _ in reduced]) if reduced else set()
    interior = sorted(hidden - frontier_cells - safe - mines)
    R = total_mines - len(mines)
    U = len(interior)

    components: list = []
    probs: dict = {x: 0.0 for x in safe}
    probs.update({x: 1.0 for x in mines})
    interior_prob = None
    exact = True

    if not use_enumeration:
        # Baseline: no global reasoning; report a naive density for display only.
        dens = R / max(1, len(hidden) - len(safe) - len(mines))
        for x in hidden:
            probs.setdefault(x, dens)
        return Analysis(rows, cols, total_mines, hidden, constraints, steps, [],
                        safe, mines, probs, interior, dens if interior else None, R,
                        False, (time.perf_counter() - t0) * 1000)

    # Stage 2: model checking on each independent component.
    groups = _components(reduced) if reduced else []
    for g in groups:
        comp = check_models(g, budget)
        if comp.exact and not comp.models_by_k:
            raise Inconsistent("a group of numbers has no satisfying assignment")
        if not comp.exact:
            exact = False
            _approximate(comp, g)
        components.append(comp)

    # Stage 3: combine components with the global mine count (exact integers).
    polys = [_poly(c) for c in components]
    prefix = [[1]]
    for p in polys:
        prefix.append(_conv(prefix[-1], p))
    suffix = [[1]]
    for p in reversed(polys):
        suffix.append(_conv(suffix[-1], p))
    suffix.reverse()
    total_poly = prefix[-1]

    def ways(m: int) -> int:                # completions of the interior with m mines
        return comb(U, m) if 0 <= m <= U else 0

    W = sum(cnt * ways(R - K) for K, cnt in enumerate(total_poly))
    if W == 0 and exact:
        raise Inconsistent("no mine layout matches the visible board")
    if W == 0:
        # The approximated component made the global count look infeasible.
        # Fall back to reasoning about each component on its own (sound, but
        # it ignores the total mine count), then estimate the interior.
        for comp in components:
            if comp.exact:
                total = comp.n_models
                for j, x in enumerate(comp.cells):
                    in_models = sum(c[j] for c in comp.mine_counts.values())
                    probs[x] = in_models / total
                    if in_models == 0:
                        safe.add(x)
                    elif in_models == total:
                        mines.add(x)
            else:
                for j, x in enumerate(comp.cells):
                    probs[x] = comp.approx_probs[j]
        if U:
            expected_frontier = sum(probs[x] for comp in components for x in comp.cells)
            interior_prob = min(1.0, max(0.0, (R - expected_frontier) / U))
            for x in interior:
                probs[x] = interior_prob
        return Analysis(rows, cols, total_mines, hidden, constraints, steps, components,
                        safe, mines, probs, interior, interior_prob, R, False,
                        (time.perf_counter() - t0) * 1000)

    for i, comp in enumerate(components):
        rest = _conv(prefix[i], suffix[i + 1])
        f = {k: sum(cnt * ways(R - k - K) for K, cnt in enumerate(rest))
             for k in comp.models_by_k}
        if comp.exact:
            n = len(comp.cells)
            weight = [0] * n
            for k, counts in comp.mine_counts.items():
                fk = f[k]
                if fk:
                    for j in range(n):
                        weight[j] += counts[j] * fk
            for j, x in enumerate(comp.cells):
                probs[x] = weight[j] / W
                if exact:
                    if weight[j] == 0:          # mine in no model  -> KB |= not M_x
                        safe.add(x)
                    elif weight[j] == W:        # mine in every model -> KB |= M_x
                        mines.add(x)
                else:
                    # Another component was only approximated, so the global
                    # combination is not exact; fall back to conclusions that
                    # hold in every model of this component alone (still sound).
                    in_models = sum(c[j] for c in comp.mine_counts.values())
                    if in_models == 0:
                        safe.add(x)
                    elif in_models == comp.n_models:
                        mines.add(x)
        else:
            for j, x in enumerate(comp.cells):
                probs[x] = comp.approx_probs[j]

    if U:
        E = sum(cnt * ways(R - K) * (R - K) for K, cnt in enumerate(total_poly))
        interior_prob = E / (U * W)
        for x in interior:
            probs[x] = interior_prob
        if exact and E == 0:
            safe.update(interior)
        elif exact and E == U * W:
            mines.update(interior)

    return Analysis(rows, cols, total_mines, hidden, constraints, steps, components,
                    safe, mines, probs, interior, interior_prob, R, exact,
                    (time.perf_counter() - t0) * 1000)
