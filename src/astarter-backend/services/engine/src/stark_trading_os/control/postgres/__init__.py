"""PG1 migration and explicit PG2 reference persistence; no default Control cutover.

Lazy exports preserve PG1 use without installing the optional postgres driver.
"""
from typing import Any

__all__ = ['PostgresApplication', 'PostgresStrategyRepository', 'open_application']


def __getattr__(name: str) -> Any:
    if name not in __all__:
        raise AttributeError(name)
    from .application import PostgresApplication, open_application
    from .strategy_repository import PostgresStrategyRepository
    return {'PostgresApplication': PostgresApplication,
            'PostgresStrategyRepository': PostgresStrategyRepository,
            'open_application': open_application}[name]
