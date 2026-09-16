"""src/position_sizer.py — lots from account risk and stop distance.

One question, answered once: given an equity, a risk budget and a stop that
is already placed, how many lots does the position get?

The arithmetic is trivial and the failure modes are not, so most of this
module is about the failure modes:

* **Pips are not universal.** The pasted version hardcoded ``pip_size`` to
  ``0.0001`` and ``pip_value_per_lot`` to ``10.0``. Those are EURUSD
  numbers. On gold — the default profile in ``config.yaml`` — a 0.0001
  "pip" is a hundredth of a cent, so a 15-point stop reads as 150,000 pips
  and the position sizes to zero. The instrument block already carries
  ``contract_size`` and ``point_value``, which is the general form: money
  lost per lot is ``points * contract_size * point_value``. That is the
  same expression :func:`src.backtester.money_for_points` uses, so live
  sizing and replay sizing cannot drift apart.

* **Rounding up breaks the budget.** ``round(lots, 2)`` rounds to nearest,
  so a computed 0.0149 becomes 0.01 (fine) but 0.0151 becomes 0.02 — a
  third more risk than the account agreed to, on every trade. Lots floor to
  the broker's step via :func:`src.utils.round_to_step`.

* **A stop at the entry is not a small stop.** ``abs(entry - stop)`` of
  zero divides into an infinite lot count. The pasted version returned
  ``lots=0.0`` but still reported the full ``risk_amount``, which reads as
  "risking $50 with no position" — a number that will be logged, summed and
  believed. A rejected size reports zero risk, because zero is what it is.

* **NaN is not a number.** ``abs(nan - stop)`` is ``nan``, ``nan <= 0`` is
  ``False``, and the guard walks straight past it into a lot count of
  ``nan``. Every input is checked for finiteness before it is used.

The result is a :class:`PositionSize` that always describes a position that
could actually be placed, or a zero-lot rejection that says why.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping

import numpy as np

from .utils import cfg_get, clamp, round_to_step, safe_div, setup_logging

log = setup_logging(__name__)

# ------------------------------------------------------------------
# TUNABLES
# ------------------------------------------------------------------

# Defaults mirror the ``instrument`` and ``risk`` blocks in config.yaml.
# They exist so the sizer is usable without a config object; a supplied
# config always wins.
DEFAULT_ACCOUNT_EQUITY = 10_000.0
DEFAULT_RISK_PER_TRADE_PCT = 0.5
DEFAULT_CONTRACT_SIZE = 100.0
DEFAULT_POINT_VALUE = 1.0
DEFAULT_MIN_LOT = 0.01
DEFAULT_LOT_STEP = 0.01
DEFAULT_MAX_LOT = 100.0

# Why a size was refused, reported on the result so a trade log can be
# grouped by cause instead of showing a bare zero.
REJECT_NONE = ""
REJECT_NO_RISK_BUDGET = "no_risk_budget"
REJECT_NO_STOP_DISTANCE = "no_stop_distance"
REJECT_BELOW_MIN_LOT = "below_min_lot"
REJECT_BAD_INPUT = "bad_input"


# ------------------------------------------------------------------
# RESULT
# ------------------------------------------------------------------


@dataclass(frozen=True)
class PositionSize:
    """A sized position, or a zero-lot rejection that explains itself.

    ``risk_amount`` is the money actually at risk at the resolved lot size,
    not the budget that was requested. Those differ whenever the lot step
    floors the position, and the difference is the whole point of flooring:
    a 0.5% budget on a $10,000 account is $50, but a 0.01-lot position on a
    15-point gold stop risks $15. Reporting the budget would overstate the
    exposure by more than three times.
    """

    lots: float
    risk_amount: float
    stop_distance: float
    stop_points: float
    risk_budget: float
    loss_per_lot: float
    reason: str = REJECT_NONE

    @property
    def is_valid(self) -> bool:
        """True when a position can actually be placed."""
        return self.lots > 0 and self.risk_amount > 0

    @property
    def risk_pct_of_budget(self) -> float:
        """Fraction of the risk budget the resolved size consumes, 0..1."""
        return safe_div(self.risk_amount, self.risk_budget, 0.0)

    @property
    def unused_budget(self) -> float:
        """Budget left on the table because of the lot step."""
        return max(0.0, self.risk_budget - self.risk_amount)

    def to_dict(self) -> dict[str, Any]:
        """JSON-safe view, rounded for a trade log."""
        return {
            "lots": round(self.lots, 4),
            "risk_amount": round(self.risk_amount, 2),
            "risk_budget": round(self.risk_budget, 2),
            "stop_distance": round(self.stop_distance, 5),
            "stop_points": round(self.stop_points, 3),
            "loss_per_lot": round(self.loss_per_lot, 4),
            "risk_pct_of_budget": round(self.risk_pct_of_budget, 4),
            "is_valid": self.is_valid,
            "reason": self.reason,
        }


def _rejected(
    reason: str,
    risk_budget: float,
    stop_distance: float = 0.0,
    stop_points: float = 0.0,
    loss_per_lot: float = 0.0,
) -> PositionSize:
    """A zero-lot result. Risk is zero because no position exists."""
    return PositionSize(
        lots=0.0,
        risk_amount=0.0,
        stop_distance=stop_distance,
        stop_points=stop_points,
        risk_budget=risk_budget,
        loss_per_lot=loss_per_lot,
        reason=reason,
    )


# ------------------------------------------------------------------
# SIZER
# ------------------------------------------------------------------


class PositionSizer:
    """Fixed-fractional sizing against a stop that is already placed.

    The sizer never decides *where* the stop goes — that is
    :mod:`src.stop_manager`'s job. It only answers how much size that stop
    can carry inside the risk budget.
    """

    def __init__(
        self,
        account_size: float | None = None,
        risk_pct: float | None = None,
        contract_size: float | None = None,
        point_value: float | None = None,
        min_lot: float | None = None,
        lot_step: float | None = None,
        max_lot: float | None = None,
        config: Mapping[str, Any] | None = None,
    ) -> None:
        cfg = config or {}

        self.account_size = float(
            account_size
            if account_size is not None
            else cfg_get(cfg, "risk.account_equity", DEFAULT_ACCOUNT_EQUITY)
        )
        self.risk_pct = float(
            risk_pct
            if risk_pct is not None
            else cfg_get(cfg, "risk.risk_per_trade_pct", DEFAULT_RISK_PER_TRADE_PCT)
        )
        self.contract_size = float(
            contract_size
            if contract_size is not None
            else cfg_get(cfg, "instrument.contract_size", DEFAULT_CONTRACT_SIZE)
        )
        self.point_value = float(
            point_value
            if point_value is not None
            else cfg_get(cfg, "instrument.point_value", DEFAULT_POINT_VALUE)
        )
        self.min_lot = float(
            min_lot
            if min_lot is not None
            else cfg_get(cfg, "instrument.min_lot", DEFAULT_MIN_LOT)
        )
        self.lot_step = float(
            lot_step
            if lot_step is not None
            else cfg_get(cfg, "instrument.lot_step", DEFAULT_LOT_STEP)
        )
        self.max_lot = float(
            max_lot
            if max_lot is not None
            else cfg_get(cfg, "instrument.max_lot", DEFAULT_MAX_LOT)
        )

    # ---- derived quantities ---------------------------------------

    @property
    def risk_budget(self) -> float:
        """Money the account is willing to lose on one setup."""
        return self.account_size * (self.risk_pct / 100.0)

    def loss_per_lot(self, stop_distance: float) -> float:
        """Money lost on one lot if the stop is hit.

        ``points * contract_size * point_value`` — the same conversion the
        backtester uses, so a live size and a replayed size agree.
        """
        return stop_distance * self.contract_size * self.point_value

    def stop_points(self, entry: float, stop: float) -> float:
        """Absolute distance between entry and stop, in price units."""
        return abs(entry - stop)

    # ---- sizing ---------------------------------------------------

    def size(self, entry: float, stop: float) -> PositionSize:
        """Lots such that a stop-out costs at most the risk budget.

        Returns a zero-lot :class:`PositionSize` with a ``reason`` when the
        geometry cannot be sized: a non-finite price, a stop sitting on the
        entry, a non-positive budget, or a position too small for the
        broker's minimum lot.
        """
        budget = self.risk_budget

        if not (np.isfinite(entry) and np.isfinite(stop)):
            log.debug("sizing rejected: non-finite entry/stop")
            return _rejected(REJECT_BAD_INPUT, budget)

        distance = self.stop_points(entry, stop)
        if distance <= 0:
            log.debug("sizing rejected: stop sits on the entry")
            return _rejected(REJECT_NO_STOP_DISTANCE, budget)

        if budget <= 0:
            log.debug("sizing rejected: risk budget is %.2f", budget)
            return _rejected(REJECT_NO_RISK_BUDGET, budget, stop_distance=distance)

        per_lot = self.loss_per_lot(distance)
        if per_lot <= 0:
            log.debug("sizing rejected: loss per lot is %.4f", per_lot)
            return _rejected(
                REJECT_BAD_INPUT, budget, stop_distance=distance, loss_per_lot=per_lot
            )

        raw_lots = budget / per_lot
        lots = round_to_step(raw_lots, self.lot_step)
        lots = clamp(lots, 0.0, self.max_lot)

        if lots < self.min_lot:
            log.debug("sizing rejected: %.4f lots below min %.4f", lots, self.min_lot)
            return _rejected(
                REJECT_BELOW_MIN_LOT,
                budget,
                stop_distance=distance,
                loss_per_lot=per_lot,
            )

        lots = round(lots, 4)
        return PositionSize(
            lots=lots,
            risk_amount=lots * per_lot,
            stop_distance=distance,
            stop_points=distance,
            risk_budget=budget,
            loss_per_lot=per_lot,
        )

    def size_for_plan(self, plan: Any) -> PositionSize:
        """Size a :class:`src.stop_manager.StopPlan` directly.

        Accepts anything carrying ``entry`` and ``stop``, so the two modules
        compose without either importing the other.
        """
        entry = getattr(plan, "entry", None)
        stop = getattr(plan, "stop", None)
        if entry is None or stop is None:
            return _rejected(REJECT_BAD_INPUT, self.risk_budget)
        return self.size(float(entry), float(stop))

    def max_lots_for_risk(self, stop_distance: float) -> float:
        """Largest stepped lot size that stays inside the budget."""
        per_lot = self.loss_per_lot(stop_distance)
        if per_lot <= 0:
            return 0.0
        lots = round_to_step(self.risk_budget / per_lot, self.lot_step)
        return round(clamp(lots, 0.0, self.max_lot), 4)

    def as_dict(self) -> dict[str, Any]:
        """Resolved settings, for a run header or a trade log."""
        return {
            "account_size": self.account_size,
            "risk_pct": self.risk_pct,
            "risk_budget": round(self.risk_budget, 2),
            "contract_size": self.contract_size,
            "point_value": self.point_value,
            "min_lot": self.min_lot,
            "lot_step": self.lot_step,
            "max_lot": self.max_lot,
        }


# ------------------------------------------------------------------
# MODULE-LEVEL WRAPPERS
# ------------------------------------------------------------------


def size_position(
    entry: float,
    stop: float,
    account_size: float | None = None,
    risk_pct: float | None = None,
    config: Mapping[str, Any] | None = None,
) -> PositionSize:
    """One-shot sizing without holding a sizer."""
    return PositionSizer(
        account_size=account_size, risk_pct=risk_pct, config=config
    ).size(entry, stop)


def lots_for_risk(
    stop_distance: float,
    account_size: float | None = None,
    risk_pct: float | None = None,
    config: Mapping[str, Any] | None = None,
) -> float:
    """Lots for a known stop distance, without an entry price."""
    return PositionSizer(
        account_size=account_size, risk_pct=risk_pct, config=config
    ).max_lots_for_risk(stop_distance)
