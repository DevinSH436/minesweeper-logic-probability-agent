"""Logic and Probability for Safe Moves: a Minesweeper-playing agent (COMP 8700)."""

from .agents import AGENTS, play
from .game import DIFFICULTIES, Game
from .solver import analyze

__all__ = ["AGENTS", "DIFFICULTIES", "Game", "analyze", "play"]
