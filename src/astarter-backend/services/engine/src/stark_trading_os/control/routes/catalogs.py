"""Immutable local fixture catalog publication and read routes."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response
from pydantic import ValidationError

from stark_trading_os.audit.canonical_json import CanonicalJSONError, parse_json_object
from stark_trading_os.catalog.fixture_publisher import CatalogPublishError
from stark_trading_os.catalog.fixture_registry import FixtureInvalid, FixtureUnknown
from stark_trading_os.control.api_adapters import parse_nonnegative_cursor
from stark_trading_os.control.api_models import ApiError, CatalogRevisionResponse, InstrumentPage
from stark_trading_os.control.dependencies import ControlDependencies, get_dependencies
from stark_trading_os.control.registry import (
    CatalogConflict,
    CatalogIntegrityFailed,
    CatalogRecoveryBlocked,
    CatalogStorageFailed,
)
from stark_trading_os.domain.models import CatalogManifestV1, ErrorResponse

router = APIRouter(prefix="/v1/catalogs", tags=["catalogs"])
Dependencies = Annotated[ControlDependencies, Depends(get_dependencies)]


@router.post(
    "/fixtures/{fixture_id}/publish",
    response_model=CatalogRevisionResponse,
    status_code=201,
    responses={
        200: {"model": CatalogRevisionResponse},
        404: {"model": ErrorResponse},
        409: {"model": ErrorResponse},
        422: {"model": ErrorResponse},
    },
)
async def publish_fixture(
    fixture_id: str,
    response: Response,
    dependencies: Dependencies,
) -> CatalogRevisionResponse:
    existing_revisions = {
        item.catalog_revision
        for item in dependencies.store.recoverable_catalog_publications()
        if item.status == "PUBLISHED"
    }
    try:
        publication = dependencies.fixture_publisher.publish(fixture_id)
    except FixtureUnknown as error:
        raise ApiError(
            status_code=404,
            code="FIXTURE_UNKNOWN",
            message="The fixture ID is not registered.",
        ) from error
    except FixtureInvalid as error:
        raise ApiError(
            status_code=422,
            code="FIXTURE_INVALID",
            message="The registered fixture failed validation.",
        ) from error
    except (CatalogConflict, CatalogIntegrityFailed, CatalogRecoveryBlocked) as error:
        raise ApiError(
            status_code=409,
            code="CATALOG_CONFLICT",
            message="The immutable catalog publication conflicts with stored authority.",
        ) from error
    except (CatalogPublishError, CatalogStorageFailed) as error:
        raise ApiError(
            status_code=422,
            code="FIXTURE_INVALID",
            message="The fixture could not be published as an immutable catalog.",
        ) from error
    response.status_code = 200 if publication.catalog_revision in existing_revisions else 201
    return CatalogRevisionResponse(
        catalog_revision=publication.catalog_revision,
        fixture_id=publication.fixture_id,
        status="PUBLISHED",
        inventory_hash=publication.inventory_hash,
    )


@router.get(
    "/{catalog_revision}/instruments",
    response_model=InstrumentPage,
    responses={404: {"model": ErrorResponse}, 422: {"model": ErrorResponse}},
)
async def catalog_instruments(
    catalog_revision: str,
    dependencies: Dependencies,
    cursor: str = Query(default="0"),
    limit: int = Query(default=100, ge=1, le=500),
) -> InstrumentPage:
    try:
        offset = parse_nonnegative_cursor(cursor)
    except ValueError as error:
        raise ApiError(
            status_code=422,
            code="CURSOR_INVALID",
            message="The catalog cursor is invalid.",
        ) from error
    try:
        publication = dependencies.fixture_publisher.revalidate(catalog_revision)
        manifest = CatalogManifestV1.model_validate(
            parse_json_object(publication.publication_bytes)
        )
    except (CatalogConflict, CatalogIntegrityFailed, CatalogRecoveryBlocked) as error:
        raise ApiError(
            status_code=404,
            code="CATALOG_UNKNOWN",
            message="The immutable catalog revision is unavailable.",
        ) from error
    except (
        CatalogPublishError,
        CatalogStorageFailed,
        CanonicalJSONError,
        ValidationError,
    ) as error:
        raise ApiError(
            status_code=404,
            code="CATALOG_UNKNOWN",
            message="The immutable catalog revision is unavailable.",
        ) from error
    instruments = (manifest.inventory.instrument,)
    if offset > len(instruments):
        raise ApiError(
            status_code=422,
            code="CURSOR_INVALID",
            message="The catalog cursor is above the immutable tail.",
        )
    page = instruments[offset : offset + limit]
    next_offset = offset + len(page)
    return InstrumentPage(
        catalog_revision=publication.catalog_revision,
        items=page,
        next_cursor=str(next_offset) if next_offset < len(instruments) else None,
    )
