"""Correctness tests.  Run with:  python -m unittest discover -s tests -v"""

import itertools
import random
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from msagent.agents import AGENTS, play  # noqa: E402
from msagent.game import HIDDEN, Game, neighbours  # noqa: E402
from msagent.solver import analyze  # noqa: E402


def view_from(rows, cols, mines, revealed):
    g = Game.from_layout(rows, cols, mines)
    for cell in revealed:
        g.revealed[cell] = g.number(cell)
    return g.view()


def brute_force(view, total):
    """Ground truth: enumerate every placement of all mines on hidden cells."""
    rows, cols = len(view), len(view[0])
    hidden = [(r, c) for r in range(rows) for c in range(cols) if view[r][c] == HIDDEN]
    counts = {x: 0 for x in hidden}
    n_layouts = 0
    for layout in itertools.combinations(hidden, total):
        s = set(layout)
        if all(view[r][c] == HIDDEN or
               view[r][c] == sum(1 for y in neighbours((r, c), rows, cols) if y in s)
               for r in range(rows) for c in range(cols)):
            n_layouts += 1
            for x in s:
                counts[x] += 1
    return {x: counts[x] / n_layouts for x in hidden}


class GameTests(unittest.TestCase):
    def test_first_click_is_safe(self):
        for seed in range(200):
            g = Game.from_difficulty("expert", seed)
            g.reveal((8, 15))
            self.assertNotEqual(g.status, "lost")

    def test_flood_fill_and_numbers(self):
        g = Game.from_layout(3, 3, {(0, 0)})
        g.reveal((2, 2))                       # a zero: opens everything but the mine
        self.assertEqual(g.status, "won")
        self.assertEqual(g.revealed[(1, 1)], 1)
        self.assertEqual(g.revealed[(2, 2)], 0)

    def test_view_hides_mines(self):
        g = Game.from_layout(2, 2, {(0, 0)})
        self.assertTrue(all(v == HIDDEN for row in g.view() for v in row))


class LogicTests(unittest.TestCase):
    def test_one_two_one_pattern(self):
        # Hidden row on top, numbers 1 2 1 below: the classic pattern says the
        # outer two are mines and the middle one is safe.
        mines = {(0, 0), (0, 2)}
        view = view_from(2, 3, mines, [(1, 0), (1, 1), (1, 2)])
        a = analyze(view, total_mines=2)
        self.assertEqual(a.mines, {(0, 0), (0, 2)})
        self.assertEqual(a.safe, {(0, 1)})

    def test_entailment_is_sound_on_random_boards(self):
        rng = random.Random(1)
        for trial in range(300):
            rows, cols = rng.randint(4, 8), rng.randint(4, 8)
            n = rng.randint(2, rows * cols // 4)
            g = Game(rows, cols, n, seed=trial)
            g.reveal((rows // 2, cols // 2))
            while not g.over:
                a = analyze(g.view(), n)
                self.assertFalse(a.safe & g.mines, "proved a mine safe")
                self.assertTrue(a.mines <= g.mines, "proved a safe cell is a mine")
                if a.safe:
                    g.reveal(min(a.safe))
                else:
                    g.reveal(rng.choice(sorted(a.hidden - a.mines)))

    def test_still_sound_when_search_budget_is_exceeded(self):
        """With a tiny budget most components are approximated; any cell still
        reported safe or mined must be correct (regression test)."""
        approximated = 0
        for seed in range(150):
            g = Game.from_difficulty("intermediate", seed)
            g.reveal((8, 8))
            rng = random.Random(seed)
            while not g.over:
                a = analyze(g.view(), g.n_mines, budget=40)
                approximated += not a.exact
                self.assertFalse(a.safe & g.mines, "proved a mine safe")
                self.assertTrue(a.mines <= g.mines, "proved a safe cell is a mine")
                if a.safe:
                    g.reveal(min(a.safe))
                else:
                    g.reveal(rng.choice(sorted(a.hidden - a.mines)))
        self.assertGreater(approximated, 50)

    def test_completeness_matches_brute_force(self):
        """Every cell that is safe in *all* layouts must be found (and vice versa)."""
        rng = random.Random(7)
        for trial in range(150):
            rows, cols, n = 4, 5, rng.randint(2, 6)
            g = Game(rows, cols, n, seed=1000 + trial)
            g.reveal((rng.randrange(rows), rng.randrange(cols)))
            if g.over:
                continue
            truth = brute_force(g.view(), n)
            a = analyze(g.view(), n)
            self.assertEqual(a.safe, {x for x, p in truth.items() if p == 0})
            self.assertEqual(a.mines, {x for x, p in truth.items() if p == 1})


class ProbabilityTests(unittest.TestCase):
    def test_probabilities_match_brute_force(self):
        rng = random.Random(3)
        checked = 0
        for trial in range(200):
            rows, cols, n = 4, 5, rng.randint(3, 7)
            g = Game(rows, cols, n, seed=trial)
            g.reveal((rng.randrange(rows), rng.randrange(cols)))
            # reveal a couple more safe cells to create a varied frontier
            for _ in range(rng.randint(0, 2)):
                if g.over:
                    break
                safe_hidden = [x for x in itertools.product(range(rows), range(cols))
                               if x not in g.mines and x not in g.revealed]
                if safe_hidden:
                    g.reveal(rng.choice(safe_hidden))
            if g.over:
                continue
            truth = brute_force(g.view(), n)
            a = analyze(g.view(), n)
            for x, p in truth.items():
                self.assertAlmostEqual(a.probs[x], p, places=9, msg=f"cell {x}")
            checked += 1
        self.assertGreater(checked, 100)

    def test_interior_probability_without_numbers_is_density(self):
        view = [[HIDDEN] * 5 for _ in range(5)]
        a = analyze(view, total_mines=5)
        self.assertAlmostEqual(a.interior_prob, 5 / 25)


class AgentTests(unittest.TestCase):
    def test_reasoning_agents_never_die_on_a_proven_safe_move(self):
        for name in ("rules", "logic", "probability"):
            for seed in range(60):
                res = play(Game.from_difficulty("beginner", seed), AGENTS[name](seed))
                self.assertNotIn(res.death_reason, ("proven-safe", "opening"), name)

    def test_random_guesses_are_independent_of_the_mines(self):
        """Regression test: forced guesses must hit mines at about the rate the
        exact model predicts, not more (a shared RNG once made them hit ~100%)."""
        predicted = hits = n = 0
        for seed in range(400):
            res = play(Game.from_difficulty("beginner", seed), AGENTS["logic"](seed))
            for p, died in res.guess_records:
                predicted += p
                hits += died
                n += 1
        self.assertGreater(n, 200)
        self.assertLess(abs(hits / n - predicted / n), 0.08)

    def test_probability_agent_beats_random_on_beginner(self):
        wins = {name: 0 for name in ("random", "probability")}
        for seed in range(100):
            for name in wins:
                wins[name] += play(Game.from_difficulty("beginner", seed), AGENTS[name](seed)).won
        self.assertGreater(wins["probability"], wins["random"] + 30)


if __name__ == "__main__":
    unittest.main()
