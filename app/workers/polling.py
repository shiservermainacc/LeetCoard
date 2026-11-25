"""Polling worker.

Schedules per-user submission fetches with jittered intervals so requests
spread evenly across the global window. Errors on any single user are
isolated — a failure for `alice` never stops polling for `bob`.

Also runs a low-priority profile-fetch loop (avatar, LC ranking, AC totals
by difficulty), exposed via `enqueue_profile_fetch()`.
"""

from __future__ import annotations

import asyncio
import logging
import random
from datetime import datetime, timedelta, timezone
from typing import Optional, Set

from ..core.config import Settings
from ..domain.state import ContestEngine
from ..integrations.leetcode import LeetCodeClient, LeetCodeError

log = logging.getLogger("gdg.polling")

PROFILE_REFRESH_SEC = 600  # refresh every 10 min while contest is live


class PollingWorker:
    def __init__(self, engine: ContestEngine, client: LeetCodeClient, settings: Settings) -> None:
        self._engine = engine
        self._client = client
        self._cfg = settings
        self._task: Optional[asyncio.Task] = None
        self._profile_task: Optional[asyncio.Task] = None
        self._stop = asyncio.Event()
        self._profile_queue: asyncio.Queue[str] = asyncio.Queue()
        self._enqueued: Set[str] = set()
        # Beat% can appear after the submission itself; keep missing values retryable.
        self._beat_retry_after: dict[str, datetime] = {}
        self._beat_retry_attempts: dict[str, int] = {}

    async def start(self) -> None:
        self._stop.clear()
        # Seed profile fetches for participants already loaded from disk.
        for u in self._engine.usernames():
            self.enqueue_profile_fetch(u)
        self._task = asyncio.create_task(self._loop(), name="polling-worker")
        self._profile_task = asyncio.create_task(self._profile_loop(), name="polling-profile")

    async def stop(self) -> None:
        self._stop.set()
        for t in (self._task, self._profile_task):
            if t is None:
                continue
            try:
                await asyncio.wait_for(t, timeout=5)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                t.cancel()
        self._task = None
        self._profile_task = None

    def enqueue_profile_fetch(self, username: str) -> None:
        """Schedule a profile/avatar fetch for `username`. Idempotent per pending."""
        if username in self._enqueued:
            return
        self._enqueued.add(username)
        try:
            self._profile_queue.put_nowait(username)
        except asyncio.QueueFull:
            self._enqueued.discard(username)

    async def _profile_loop(self) -> None:
        log.info("Polling profile loop started")
        next_refresh = datetime.now(timezone.utc) + timedelta(seconds=PROFILE_REFRESH_SEC)
        while not self._stop.is_set():
            try:
                now = datetime.now(timezone.utc)
                if now >= next_refresh:
                    for u in self._engine.usernames():
                        self.enqueue_profile_fetch(u)
                    next_refresh = now + timedelta(seconds=PROFILE_REFRESH_SEC)
                try:
                    username = await asyncio.wait_for(self._profile_queue.get(), timeout=1.0)
                except asyncio.TimeoutError:
                    continue
                self._enqueued.discard(username)
                await self._fetch_profile(username)
            except asyncio.CancelledError:
                break
            except Exception:
                log.exception("Profile loop hiccup")
                await asyncio.sleep(2)

    async def _fetch_profile(self, username: str) -> None:
        try:
            data = await self._client.get_user_profile(username)
        except LeetCodeError as exc:
            log.warning("Profile fetch failed for %s: %s", username, exc)
            return
        profile = data.get("profile") or {}
        stats = (data.get("submitStats") or {}).get("acSubmissionNum") or []
        easy = medium = hard = 0
        for row in stats:
            d = (row.get("difficulty") or "").lower()
            c = int(row.get("count") or 0)
            if d == "easy":
                easy = c
            elif d == "medium":
                medium = c
            elif d == "hard":
                hard = c
        await self._engine.update_profile(
            username,
            avatar_url=profile.get("userAvatar"),
            lc_ranking=profile.get("ranking"),
            easy_total=easy,
            medium_total=medium,
            hard_total=hard,
        )

    async def _loop(self) -> None:
        # Per-user next-due times. Initialised on first sight.
        next_due: dict[str, datetime] = {}
        log.info("Polling worker started")
        while not self._stop.is_set():
            try:
                if not self._engine.is_polling_window():
                    await asyncio.sleep(2)
                    continue

                usernames = self._engine.usernames()
                if not usernames:
                    await asyncio.sleep(2)
                    continue

                now = datetime.now(timezone.utc)
                base = self._cfg.poll_interval_sec
                jitter = self._cfg.poll_jitter

                for i, u in enumerate(usernames):
                    if u not in next_due:
                        offset = (i * base / max(1, len(usernames))) + random.uniform(0, base * jitter)
                        next_due[u] = now + timedelta(seconds=offset)

                due = [u for u, t in next_due.items() if t <= now]
                if not due:
                    sleep_for = max(0.1, min((next_due[u] - now).total_seconds() for u in usernames))
                    await asyncio.sleep(min(sleep_for, 1.0))
                    continue

                tasks = [self._poll_one(u) for u in due]
                await asyncio.gather(*tasks, return_exceptions=True)

                for u in due:
                    delay = base * (1 + random.uniform(-jitter, jitter))
                    next_due[u] = datetime.now(timezone.utc) + timedelta(seconds=max(0.5, delay))

                stale = set(next_due) - set(usernames)
                for u in stale:
                    next_due.pop(u, None)

            except Exception:
                log.exception("Polling loop hiccup; sleeping 2s")
                await asyncio.sleep(2)

    async def _enrich_runtime_percentile(self, username: str, subs: list[dict]) -> None:
        """Fetch missing runtime percentiles and keep transient misses retryable."""
        now = datetime.now(timezone.utc)
        candidates: dict[str, dict] = {}
        contest = self._engine.contest
        tracked_slugs = {problem.title_slug for problem in contest.problems}
        tracked_titles: dict[str, list] = {}
        for problem in contest.problems:
            title_key = self._normalize_title(problem.title)
            if title_key:
                tracked_titles.setdefault(title_key, []).append(problem)
        existing_events = {
            str(event.submission_id): event
            for event in contest.events
            if event.username == username and event.submission_id is not None
        }
        for sub in subs:
            if (sub.get("statusDisplay") or sub.get("status")) != "Accepted":
                continue
            sub_id = str(sub.get("id") or "")
            existing_event = existing_events.get(sub_id)
            if existing_event is not None and existing_event.beat_pct is not None:
                # The list endpoint omits Beat%, so don't refetch a value
                # already persisted on the corresponding contest event.
                continue
            slug = sub.get("titleSlug") or sub.get("title_slug")
            title_matches = tracked_titles.get(self._normalize_title(sub.get("title")), [])
            is_tracked = slug in tracked_slugs or len(title_matches) == 1
            try:
                submitted_at = datetime.fromtimestamp(int(sub.get("timestamp")), tz=timezone.utc)
            except (TypeError, ValueError, OSError):
                continue
            if (
                sub_id
                and is_tracked
                and contest.start_time is not None
                and contest.end_time is not None
                and contest.start_time <= submitted_at <= contest.end_time
                and self._read_percentile(sub) is None
            ):
                candidates[sub_id] = sub

        # Also retry tracked events that have aged out of the recent list.
        current_by_id = {str(sub.get("id") or ""): sub for sub in subs}
        current_ids = set(current_by_id)
        for event in self._engine.contest.events:
            if (event.username != username or not event.is_tracked or not event.is_accepted
                    or event.beat_pct is not None or event.submission_id is None):
                continue
            start = self._engine.contest.start_time
            end = self._engine.contest.end_time
            if start is None or end is None or not (start <= event.submitted_at <= end):
                continue
            sub_id = str(event.submission_id)
            current_submission = current_by_id.get(sub_id)
            if current_submission is not None and self._read_percentile(current_submission) is not None:
                continue
            retry_payload = {
                "id": sub_id,
                "statusDisplay": "Accepted",
                "titleSlug": event.title_slug,
                "title": event.title,
                "timestamp": int(event.submitted_at.timestamp()),
            }
            candidates.setdefault(sub_id, retry_payload)
            if sub_id not in current_ids:
                subs.append(retry_payload)
                current_ids.add(sub_id)

        for sub_id, sub in candidates.items():
            if self._beat_retry_after.get(sub_id, now) > now:
                continue
            pct = await self._client.get_submission_runtime_percentile(sub_id)
            if pct is not None and 0.0 <= pct <= 100.0:
                sub["runtimePercentile"] = pct
                self._beat_retry_after.pop(sub_id, None)
                self._beat_retry_attempts.pop(sub_id, None)
                log.info("Loaded Beat %.2f%% for submission %s", pct, sub_id)
            else:
                attempt = self._beat_retry_attempts.get(sub_id, 0) + 1
                self._beat_retry_attempts[sub_id] = attempt
                delay = min(300, 15 * (2 ** min(attempt - 1, 5)))
                self._beat_retry_after[sub_id] = now + timedelta(seconds=delay)
                log.info(
                    "Beat still unavailable for submission %s; retry in %ss (attempt %s)",
                    sub_id,
                    delay,
                    attempt,
                )

    @staticmethod
    def _normalize_title(value: object) -> str:
        return " ".join(str(value or "").casefold().split())

    @staticmethod
    def _read_percentile(sub: dict) -> Optional[float]:
        for key in ("runtimePercentile", "runtime_percentile", "beatPercentile", "beat_percentile"):
            value = sub.get(key)
            if value is None:
                continue
            try:
                pct = float(value)
            except (TypeError, ValueError):
                continue
            if 0.0 <= pct <= 100.0:
                return pct
        return None

    async def _poll_one(self, username: str) -> None:
        try:
            subs = await self._client.get_recent_submissions(
                username, limit=self._cfg.poll_recent_limit
            )
            await self._enrich_runtime_percentile(username, subs)
            await self._engine.ingest_submissions(username, subs)
        except LeetCodeError as exc:
            log.warning("Poll failed for %s: %s", username, exc)
        except Exception:
            log.exception("Unexpected polling error for %s", username)
