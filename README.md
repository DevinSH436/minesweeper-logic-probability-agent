# Logic and Probability for Safe Moves: a Minesweeper-playing agent

COMP 8700 (Introduction to Artificial Intelligence), Fall 2026 course project.

The agent treats the revealed numbers as a propositional **knowledge base** and uses **entailment by model
checking** (AIMA Ch. 7) to prove squares safe or mined, the way the Wumpus World agent reasons about pits.
When nothing can be proven, it computes the **exact probability** of a mine on every square (AIMA Ch. 12.7,
extended with the global mine count) and reveals the safest one: a maximum-expected-utility choice.

## Requirements

* Python **3.10 or newer**. Nothing else: only the standard library is used (no `pip install` needed).
* Any modern browser for the website.

## Quick start

```bash
cd minesweeper_agent
python -m unittest discover -s tests -v     # 1. check correctness (about 10 s)
python server.py                            # 2. open the website at http://127.0.0.1:8700
python experiments.py --games 3000          # 3. reproduce the main experiment (about 5 min)
```

`python server.py --no-browser --port 9000` changes the port or skips opening a browser.

## The website (`server.py`)

| Tab | What it shows |
|-----|---------------|
| Overview | The idea, the four players, headline results (read from `results/`) |
| Problem & agent | PEAS, environment properties, problem formulation, belief states, agent types (Ch 2, 3, 4.4) |
| Logic (Ch 7) | The knowledge base, CNF of a number (interactive), entailment, model checking, soundness/completeness |
| Probability (Ch 12) | The Wumpus pit calculation, the C(U, R−k) weighting, a worked example, maximum expected utility, Bayes-net view |
| Step by step | Pauses the agent and shows each stage of one decision on a real board |
| Live board | Any player on any board size with a probability overlay; or play yourself with the agent advising |
| Main experiment | The experiment design; one board played by all four players side by side; a **Run experiment** button that runs `experiments.py` on the server with live progress, then shows every result (charts, tables, McNemar tests, calibration, raw per-game data) with downloads |
| Results (3,000 games) | The official results used in the report: win rates with 95% CIs, guesses, progress, calibration, paired tests |
| Chapters & references | Which AIMA chapters are used and why; references; reproduction commands |

## Project layout

```
msagent/game.py      Minesweeper environment (first click safe, flood fill, percept = view())
msagent/solver.py    Knowledge base, single-number rules, model checking, exact probabilities
msagent/agents.py    Random, Local rules, Logic only, Logic + probability; play() + metrics
experiments.py       Runs every player on every board, writes results/
server.py            Local web server + JSON API for the website (standard library only)
web/                 index.html, style.css, app.js (no external libraries)
tests/test_agent.py  Unit tests (logic and probabilities checked against brute force)
results/             official results: summary.json, calibration.json, games.csv, run_log.txt
results/runs/<time>/ results of runs started with the website's "Run experiment" button
```

## Representative test case

`tests/test_agent.py::LogicTests::test_one_two_one_pattern`: a hidden row above the numbers `1 2 1`.
The agent must prove the two outer squares are mines and the middle one is safe:

```python
from msagent.solver import analyze
HIDDEN = -1
view = [[HIDDEN, HIDDEN, HIDDEN],
        [1,      2,      1     ]]
a = analyze(view, total_mines=2)
print(a.mines)   # {(0, 0), (0, 2)}
print(a.safe)    # {(0, 1)}
```

Other tests compare every logical conclusion and every probability with a brute-force enumeration of all
mine layouts on small boards, and check that no reasoning player ever dies on a move it proved safe.

## Reproducing the key experiment

```bash
python experiments.py --games 3000
```

Seeds `0..2999` are used for every player, so the logic and probability players face identical boards.
Results (3000 games per cell, first-click-safe rule, centre opening):

| Win rate | Beginner 9×9/10 | Intermediate 16×16/40 | Expert 16×30/99 |
|---|---|---|---|
| Random | 0.0% | 0.0% | 0.0% |
| Local rules | 67.0% | 34.0% | 1.1% |
| Logic only | 79.5% | 59.5% | 19.8% |
| **Logic + probability** | **85.2%** | **71.0%** | **36.0%** |

All differences between consecutive players are significant on McNemar's paired test (p < 0.001).
Exact numbers, timings and calibration are in `results/summary.json` and on the Experiments tab.
Timings depend on the machine.

## References

* S. Russell and P. Norvig, *Artificial Intelligence: A Modern Approach*, 4th ed., Global Edition, Pearson, 2022.
* R. Kaye, "Minesweeper is NP-complete", *The Mathematical Intelligencer* 22(2), 2000.
