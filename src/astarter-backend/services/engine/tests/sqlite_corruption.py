"""Deliberate test-only database corruption through a current writer connection.

Only use this helper to deliberately corrupt newly synthesized test databases.
Do not use it in old-binary fencing tests: its current-writer capabilities would
invalidate that scenario. Production callers must use the Control DB factory.
"""

import sqlite3
from pathlib import Path


def open_corruption_connection(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(path)
    connection.create_function(
        "stark_control_writer_schema_version", 0, lambda: 9, deterministic=True,
    )
    connection.create_function(
        "stark_control_writer_schema7", 0, lambda: 7, deterministic=True,
    )
    connection.create_function(
        "stark_control_writer_schema8", 0, lambda: 8, deterministic=True,
    )
    connection.create_function(
        "stark_control_writer_schema9", 0, lambda: 9, deterministic=True,
    )
    return connection
