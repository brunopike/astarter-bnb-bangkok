"""Sanitize only diagnostics emitted inside our native pools, before formatting.

Psycopg 3.3.3 reset/worker diagnostics don't always carry a pool/name in args.
Resolve ownership from the nearest native pool/task frame, not message text,
thread names or exception strings. Weak registrations outlive close's bounded
join (late workers/checked-out connections) but never keep a pool alive.
"""
import logging
import sys
import threading
import weakref
from types import FrameType, MethodType
from typing import Any

from psycopg_pool import ConnectionPool
from psycopg_pool._task import Task
from psycopg_pool.pool import MaintenanceTask
from psycopg_pool.sched import Scheduler

_lock = threading.RLock()
_owned: dict[int, weakref.ReferenceType[ConnectionPool[Any]]] = {}
_loggers = tuple(logging.getLogger(name) for name in ('psycopg.pool', 'psycopg_pool.sched'))


class _OwnedDiagnostics(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        frame: FrameType | None = sys._getframe(1)
        try:
            while frame is not None:
                if frame.f_globals.get('__name__', '').startswith('psycopg_pool.'):
                    owner = frame.f_locals.get('self')
                    if frame.f_code is Scheduler.run.__code__:
                        # Scheduler catches after tick's frame is gone. Its own
                        # Task/action, not scheduler identity or log args, owns it.
                        task = frame.f_locals.get('task')
                        if type(task) is not Task:
                            break
                        action = task.action
                        if (type(action) is not MethodType
                                or action.__func__ is not MaintenanceTask.tick
                                or not isinstance(action.__self__, MaintenanceTask)):
                            break  # unrelated action on a shared scheduler
                        owner = action.__self__
                    if not isinstance(owner, (ConnectionPool, MaintenanceTask)):
                        owner = frame.f_locals.get('task')
                    if isinstance(owner, MaintenanceTask):
                        owner = owner.pool()
                    if isinstance(owner, ConnectionPool):
                        with _lock:
                            ref = _owned.get(id(owner))
                            owned = ref is not None and ref() is owner
                        if owned:
                            # Drop ALL formatting inputs, including traceback/stack text.
                            record.msg = 'PG_POOL_DIAGNOSTIC'
                            record.args = ()
                            record.exc_info = None
                            record.exc_text = None
                            record.stack_info = None
                        break  # nearest pool wins: nested unrelated pools stay unrelated
                frame = frame.f_back
        finally:
            del frame
        return True


_filter = _OwnedDiagnostics()


def protect(pool: ConnectionPool[Any]) -> None:
    """Register before open; final weak release removes the shared filter."""
    key = id(pool)

    def release(ref: weakref.ReferenceType[ConnectionPool[Any]]) -> None:
        with _lock:
            if _owned.get(key) is ref:
                del _owned[key]
            if not _owned:
                for logger in _loggers:
                    logger.removeFilter(_filter)

    with _lock:
        _owned[key] = weakref.ref(pool, release)
        for logger in _loggers:
            logger.addFilter(_filter)
