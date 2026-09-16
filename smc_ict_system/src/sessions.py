"""src/sessions.py — session and killzone windows in UTC.

The package already answers "which killzone is it right now?" through
``utils.current_killzone``. That function is a single-shot lookup: give it
a moment, get a label or ``None``. It is the right shape for a live scan
and the wrong shape for anything that needs to ask the question more than
once — a backtest walking 50,000 bars, a report grouping trades by window,
a filter that wants to know whether a *range* of bars sits inside one
window.

``SessionFilter`` is that second shape. It parses the config once, keeps
the windows as ``datetime.time`` pairs, and then answers membership
questions without re-reading YAML or re-parsing ``"07:00"`` on every call.

Two deliberate differences from ``utils.current_killzone``:

1. **Half-open windows.** ``utils._in_window`` tests ``start <= t < end``.
   The pasted version tested ``start <= t <= end``, which makes 10:00:00
   belong to both ``london_open`` (07:00-10:00) and whatever opens at
   10:00. On a 15m frame that is one bar per boundary landing in two
   windows, and the label you get depends on dict iteration order. This
   module matches ``utils`` — half-open — so the two agree.

2. **Config shape.** The pasted version expected a *list* of dicts with an
   ``enabled`` flag. The real config carries a *dict* keyed by label, and
   ``config.eurusd.yaml`` documents that disabled windows are omitted
   rather than carried as dead keys. A list is still accepted, because a
   caller building windows programmatically should not have to invent
   labels-as-keys, but the dict form is the one the config uses.

The module is read-only with respect to config: it never mutates the
mapping it is handed.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, time
from typing import Any, Iterable, Mapping, Sequence

import pandas as pd

from .utils import DEFAULTS, parse_hhmm, to_utc

# ------------------------------------------------------------------
# WINDOW
# ------------------------------------------------------------------


@dataclass(frozen=True)
class Window:
    """One named UTC window, resolved to clock times.

    ``start`` and ``end`` are ``datetime.time``. When ``start > end`` the
    window wraps midnight — ``asia_range`` at 22:00-03:00 is the common
    case in FX, and the wrap is handled by ``contains`` rather than by
    splitting the window into two.
    """

    name: str
    start: time
    end: time

    @property
    def wraps_midnight(self) -> bool:
        return self.start > self.end

    def contains(self, clock: time) -> bool:
        """Half-open membership: ``start <= clock < end``.

        A window that wraps midnight is the union of ``[start, 24:00)`` and
        ``[00:00, end)``, which is exactly ``clock >= start or clock < end``.
        """
        if self.wraps_midnight:
            return clock >= self.start or clock < self.end
        return self.start <= clock < self.end

    def duration_minutes(self) -> int:
        """Length of the window in minutes, wrap included."""
        start_min = self.start.hour * 60 + self.start.minute
        end_min = self.end.hour * 60 + self.end.minute
        if self.wraps_midnight:
            return (24 * 60 - start_min) + end_min
        return end_min - start_min

    def as_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "start": self.start.strftime("%H:%M"),
            "end": self.end.strftime("%H:%M"),
            "wraps_midnight": self.wraps_midnight,
            "duration_minutes": self.duration_minutes(),
        }


# ------------------------------------------------------------------
# PARSING
# ------------------------------------------------------------------


def _coerce_windows(source: Any) -> list[Window]:
    """Turn either config shape into a list of ``Window``.

    Accepts:

    * a mapping of ``label -> {"start": "HH:MM", "end": "HH:MM"}`` — the
      shape ``config.yaml`` and ``config.eurusd.yaml`` use;
    * a sequence of ``{"name": ..., "start": ..., "end": ...}`` dicts —
      the shape the pasted version used, kept so a caller can build a
      filter from an ad-hoc list;
    * a sequence of ``Window`` — passed through.

    Entries carrying ``enabled: false`` are skipped in the sequence form.
    The mapping form has no ``enabled`` flag by design: a window that is
    off is absent, not present-and-false.
    """
    windows: list[Window] = []

    if isinstance(source, Mapping):
        for label, spec in source.items():
            if not isinstance(spec, Mapping):
                raise ValueError(
                    f"killzone {label!r} must be a mapping with start/end, "
                    f"got {type(spec).__name__}"
                )
            if not spec.get("enabled", True):
                continue
            windows.append(
                Window(
                    name=str(label),
                    start=parse_hhmm(spec["start"]),
                    end=parse_hhmm(spec["end"]),
                )
            )
        return windows

    if isinstance(source, Sequence) and not isinstance(source, (str, bytes)):
        for entry in source:
            if isinstance(entry, Window):
                windows.append(entry)
                continue
            if not isinstance(entry, Mapping):
                raise ValueError(
                    f"killzone entry must be a mapping or Window, "
                    f"got {type(entry).__name__}"
                )
            if not entry.get("enabled", True):
                continue
            if "name" not in entry:
                raise ValueError(f"killzone entry is missing 'name': {entry!r}")
            windows.append(
                Window(
                    name=str(entry["name"]),
                    start=parse_hhmm(entry["start"]),
                    end=parse_hhmm(entry["end"]),
                )
            )
        return windows

    raise ValueError(
        f"killzones must be a mapping or a sequence, got {type(source).__name__}"
    )


# ------------------------------------------------------------------
# FILTER
# ------------------------------------------------------------------


class SessionFilter:
    """Membership tests against the configured killzone windows.

    Construct once per run and reuse. Parsing happens in ``__init__``; the
    per-call cost is a timezone coercion and a linear scan over a handful
    of windows.

    ``config`` is the full engine config, not the ``killzones`` block —
    the same object ``utils.current_killzone`` expects. Passing the block
    itself also works, because ``_coerce_windows`` accepts a bare mapping.
    """

    def __init__(self, config: Mapping[str, Any] | None = None):
        if config is None:
            source = DEFAULTS["killzones"]
        elif isinstance(config, Mapping) and "killzones" in config:
            source = config["killzones"]
        else:
            # Either a bare killzones mapping was handed in directly, or
            # something that is not a mapping at all — ``_coerce_windows``
            # raises on the latter with a message naming the type.
            source = config

        self.windows: list[Window] = _coerce_windows(source)
        self._by_name: dict[str, Window] = {w.name: w for w in self.windows}

    # -- introspection ---------------------------------------------

    def __len__(self) -> int:
        return len(self.windows)

    def __repr__(self) -> str:
        names = ", ".join(w.name for w in self.windows)
        return f"SessionFilter({len(self.windows)} windows: {names})"

    @property
    def names(self) -> list[str]:
        """Window labels in config order."""
        return [w.name for w in self.windows]

    def window(self, name: str) -> Window | None:
        """Look up one window by label. Case-sensitive, as config keys are."""
        return self._by_name.get(name)

    def as_dict(self) -> dict[str, Any]:
        return {"windows": [w.as_dict() for w in self.windows]}

    # -- membership ------------------------------------------------

    def _clock(self, moment: Any) -> time | None:
        """Coerce a timestamp to a UTC clock time, or ``None`` if unusable.

        ``utils.to_utc`` handles naive datetimes by *assuming* UTC rather
        than localising to the machine's zone, which is what we want: a
        naive bar timestamp in this package is UTC by convention.

        ``NaT`` needs catching before ``to_utc`` sees it. ``to_utc`` calls
        ``.to_pydatetime()`` on a ``pd.Timestamp``, and for ``NaT`` that
        returns a ``NaTType`` whose ``tzinfo`` is ``None`` — so ``to_utc``
        takes the naive branch, calls ``.replace(tzinfo=UTC)``, and hands
        back a ``NaTType`` that raises ``ValueError`` on ``.time()``. The
        check is ``pd.isna`` rather than an identity test because ``NaT``
        also arrives as ``pd.Timestamp("NaT")`` and as ``float("nan")``
        from a numeric column.
        """
        if moment is None:
            return None
        try:
            if pd.isna(moment):
                return None
        except (TypeError, ValueError):
            # pd.isna on an array-like returns an array; not our case, but
            # a caller passing a list should get None rather than a raise.
            return None
        try:
            moment_utc = to_utc(moment)
        except (ValueError, TypeError, OverflowError):
            return None
        if moment_utc is None:
            return None
        # ``to_utc`` can hand back a ``NaTType`` even after the check above:
        # it calls ``.to_pydatetime()`` on a ``pd.Timestamp``, and for
        # ``NaT`` that returns a ``NaTType`` whose ``tzinfo`` is ``None``,
        # so ``to_utc`` takes the naive branch, calls
        # ``.replace(tzinfo=UTC)``, and returns something that still raises
        # ``ValueError`` on ``.time()``. ``pd.isna`` catches that too, but
        # only if it is applied to the *result* — the input may have been a
        # plain ``datetime`` that ``to_utc`` converted into a ``NaTType``.
        try:
            if pd.isna(moment_utc):
                return None
        except (TypeError, ValueError):
            return None
        try:
            return moment_utc.time()
        except (ValueError, TypeError, AttributeError):
            return None

    def active_killzone(self, moment: Any) -> str | None:
        """Label of the window containing ``moment``, or ``None``.

        First match in config order wins. With half-open windows a moment
        can only sit in two windows if the config itself overlaps them —
        ``ny_am`` 12:00-15:00 and a hypothetical 14:00-17:00 window, say —
        and in that case config order is the tiebreak, which is the same
        rule ``utils.current_killzone`` applies.
        """
        clock = self._clock(moment)
        if clock is None:
            return None
        for window in self.windows:
            if window.contains(clock):
                return window.name
        return None

    def in_killzone(self, moment: Any) -> bool:
        """Whether ``moment`` falls inside any configured window."""
        return self.active_killzone(moment) is not None

    def in_named(self, moment: Any, name: str) -> bool:
        """Whether ``moment`` falls inside one specific window."""
        window = self._by_name.get(name)
        if window is None:
            return False
        clock = self._clock(moment)
        if clock is None:
            return False
        return window.contains(clock)

    # -- vectorised ------------------------------------------------

    def _utc_index(self, index: pd.DatetimeIndex) -> pd.DatetimeIndex:
        """Coerce an index to UTC. Naive is treated as UTC, per ``to_utc``.

        A ``NaT`` in the index survives ``tz_localize``/``tz_convert`` as
        ``NaT``, and ``NaT.hour`` is ``-1`` — which would silently land in
        no window rather than raising. That is the behaviour we want, but
        it is worth knowing it is deliberate: a bar with no timestamp is
        not in a killzone.
        """
        if not isinstance(index, pd.DatetimeIndex):
            index = pd.DatetimeIndex(index)
        if index.tz is None:
            return index.tz_localize("UTC")
        return index.tz_convert("UTC")

    def _window_hit(self, minutes: pd.Index, window: Window) -> pd.Series:
        """Boolean Series: True where ``minutes`` falls inside ``window``.

        ``minutes`` is minutes-since-midnight as an integer Index. Working
        in minutes rather than comparing ``time`` objects keeps the whole
        thing vectorised — a 50,000-bar frame is four comparisons per
        window, not 50,000 Python calls.
        """
        start_min = window.start.hour * 60 + window.start.minute
        end_min = window.end.hour * 60 + window.end.minute
        if window.wraps_midnight:
            return (minutes >= start_min) | (minutes < end_min)
        return (minutes >= start_min) & (minutes < end_min)

    def mask(self, index: pd.DatetimeIndex) -> pd.Series:
        """Boolean Series over ``index``: True where a killzone is open.

        Built for the backtester, which wants to slice a whole frame rather
        than call ``in_killzone`` once per bar. The returned Series carries
        the *original* index, so it can be used directly as a boolean mask.
        """
        utc_index = self._utc_index(index)
        minutes = utc_index.hour * 60 + utc_index.minute

        result = pd.Series(False, index=utc_index, dtype=bool)
        for window in self.windows:
            result |= self._window_hit(minutes, window)

        # Re-label to the caller's index so the mask lines up with the frame.
        result.index = pd.DatetimeIndex(index)
        return result

    def labels(self, index: pd.DatetimeIndex) -> pd.Series:
        """Per-bar window label, ``None`` outside every window.

        ``object`` dtype rather than a categorical: the caller usually
        wants to compare against ``None`` and group by the raw label, and
        a categorical with ``None`` in it is more trouble than it saves.
        """
        utc_index = self._utc_index(index)
        minutes = utc_index.hour * 60 + utc_index.minute

        out = pd.Series([None] * len(utc_index), index=utc_index, dtype=object)

        # Reverse order so the first window in config order wins the
        # overwrite, matching active_killzone's first-match rule.
        for window in reversed(self.windows):
            out[self._window_hit(minutes, window)] = window.name

        out.index = pd.DatetimeIndex(index)
        return out

    def count_bars(self, index: pd.DatetimeIndex) -> dict[str, int]:
        """Bars per window, plus ``"outside"``. Useful for a data audit."""
        labels = self.labels(index)
        counts = {name: 0 for name in self.names}
        counts["outside"] = 0
        for value in labels:
            if value is None:
                counts["outside"] += 1
            else:
                counts[value] += 1
        return counts


# ------------------------------------------------------------------
# MODULE-LEVEL HELPERS
# ------------------------------------------------------------------


def killzone_windows(config: Mapping[str, Any] | None = None) -> list[Window]:
    """The configured windows as a list, without building a filter."""
    return SessionFilter(config).windows


def in_killzone(moment: Any, config: Mapping[str, Any] | None = None) -> bool:
    """One-shot membership test. Convenience wrapper over ``SessionFilter``.

    For a single question this is fine. For a loop, build the filter once
    and call ``in_killzone`` on it — this rebuilds the window list on
    every call.
    """
    return SessionFilter(config).in_killzone(moment)


def active_killzone(moment: Any, config: Mapping[str, Any] | None = None) -> str | None:
    """One-shot label lookup. Convenience wrapper over ``SessionFilter``."""
    return SessionFilter(config).active_killzone(moment)


__all__ = [
    "SessionFilter",
    "Window",
    "active_killzone",
    "in_killzone",
    "killzone_windows",
]
