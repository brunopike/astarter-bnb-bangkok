"""Bounded discovery of committed catalogs; never inspect or repair their files."""

from __future__ import annotations

import re
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager

from stark_trading_os.audit.historical_input import dataset_binding_from_catalog
from stark_trading_os.catalog.historical_catalog import (
    catalog_schema_from_bytes,
    parse_historical_manifest_bytes,
)
from stark_trading_os.control.api_models import ApiError
from stark_trading_os.control.historical_api_models import (
    HistoricalCatalogPage,
    HistoricalCatalogResponse,
)
from stark_trading_os.control.historical_preflight import _snapshot
from stark_trading_os.control.registry import (
    CatalogPublication,
    CatalogStorageFailed,
    ControlStore,
    ControlStoreError,
)


def _error(status: int, code: str) -> ApiError:
    return ApiError(status_code=status, code=code, message=code)


@contextmanager
def _catalog_errors() -> Iterator[None]:
    try:
        yield
    except (CatalogStorageFailed, sqlite3.Error):
        raise _error(503, "CONTROL_UNAVAILABLE") from None
    except (ControlStoreError, ValueError, TypeError, KeyError):
        raise _error(409, "CATALOG_INTEGRITY_FAILED") from None


def _historical(publication: CatalogPublication) -> HistoricalCatalogResponse | None:
    # The existing row reader already validates both versions and their audit.
    if catalog_schema_from_bytes(publication.publication_bytes) == "CatalogManifest.v1":
        return None
    catalog = parse_historical_manifest_bytes(publication.publication_bytes)
    inventory = catalog.inventory
    instrument = inventory.instrument
    if publication.status != "PUBLISHED" or publication.published_at_ns is None:
        raise ValueError("Catalog is not published.")
    return HistoricalCatalogResponse(
        dataset=dataset_binding_from_catalog(
            publication.publication_bytes, expected_revision=publication.catalog_revision
        ),
        source_label=inventory.metadata.source.name,
        source_market=instrument.source_market,
        source_symbol=instrument.source_raw_symbol,
        price_precision=instrument.price_precision,
        size_precision=instrument.size_precision,
        price_increment=instrument.price_increment,
        size_increment=instrument.size_increment,
        minimum_quantity=instrument.minimum_quantity,
        published_at_ns=str(publication.published_at_ns),
    )


def historical_catalog_page(
    store: ControlStore, *, after_revision: str | None = None, limit: int = 20
) -> HistoricalCatalogPage:
    if type(limit) is not int or not 1 <= limit <= 100:
        raise ValueError("Catalog page limit is invalid.")
    if after_revision is not None and (
        type(after_revision) is not str or re.fullmatch(r"[0-9a-f]{64}", after_revision) is None
    ):
        raise ValueError("Catalog page cursor is invalid.")
    with _catalog_errors(), _snapshot(store._connection):
        rows = store._connection.execute(
            """SELECT catalog_revision, status FROM catalog_publications
               WHERE catalog_revision > ?
               ORDER BY catalog_revision LIMIT ?""",
            (after_revision if after_revision is not None else "", limit + 1),
        ).fetchall()
        selected = rows[:limit]
        items: list[HistoricalCatalogResponse] = []
        for row in selected:
            if row["status"] != "PUBLISHED":
                continue
            publication = store.catalog_publication(row["catalog_revision"])
            if publication is None or publication.status != "PUBLISHED":
                raise ValueError("Catalog changed inside the read snapshot.")
            item = _historical(publication)
            if item is not None:
                items.append(item)
        return HistoricalCatalogPage(
            items=tuple(items),
            next_cursor=selected[-1]["catalog_revision"] if len(rows) > limit else None,
        )


def historical_catalog_detail(
    store: ControlStore, catalog_revision: str
) -> HistoricalCatalogResponse:
    with _catalog_errors(), _snapshot(store._connection):
        publication = store.catalog_publication(catalog_revision)
        if publication is None or publication.status != "PUBLISHED":
            raise _error(404, "CATALOG_UNKNOWN")
        result = _historical(publication)
        if result is None:
            raise _error(404, "CATALOG_UNKNOWN")
        return result
