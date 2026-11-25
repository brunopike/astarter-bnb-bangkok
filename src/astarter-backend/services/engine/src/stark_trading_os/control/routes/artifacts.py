"""Fixed-enum verified artifact index and download routes."""

from __future__ import annotations

from typing import Annotated, cast

from fastapi import APIRouter, Depends, Response

from stark_trading_os.audit.canonical_json import CanonicalJSONError, parse_json_object
from stark_trading_os.control.api_adapters import ARTIFACT_PATHS, artifact_entries
from stark_trading_os.control.api_models import (
    ApiError,
    ArtifactIndex,
    ArtifactPublicationStatus,
    EvidenceStatus,
    PublicArtifactName,
)
from stark_trading_os.control.dependencies import ControlDependencies, get_dependencies
from stark_trading_os.control.recovery import ArtifactAccessDenied, ArtifactIntegrityError
from stark_trading_os.control.registry import RunNotFound
from stark_trading_os.domain.models import ErrorResponse

router = APIRouter(prefix="/v1/backtests/{run_id}/artifacts", tags=["artifacts"])
Dependencies = Annotated[ControlDependencies, Depends(get_dependencies)]


@router.get(
    "",
    response_model=ArtifactIndex,
    responses={404: {"model": ErrorResponse}, 409: {"model": ErrorResponse}},
)
async def artifact_index(run_id: str, dependencies: Dependencies) -> ArtifactIndex:
    try:
        snapshot = dependencies.store.run(run_id)
    except RunNotFound as error:
        raise _run_unknown(run_id) from error
    sealed_paths: frozenset[str] = frozenset()
    if snapshot.evidence_status == "VERIFIED":
        try:
            seal_bytes = dependencies.recovery.read_artifact(
                run_id=run_id,
                relative_path=ARTIFACT_PATHS[PublicArtifactName.SEAL],
            )
            sealed_paths = _sealed_paths(seal_bytes) | {"seal.json"}
        except ArtifactAccessDenied as error:
            raise _artifact_unverified(run_id) from error
        except (ArtifactIntegrityError, CanonicalJSONError, ValueError) as error:
            raise _artifact_integrity_failed(run_id) from error
    evidence_status = cast(EvidenceStatus, snapshot.evidence_status)
    publication_status = _publication_status(evidence_status)
    return ArtifactIndex(
        run_id=run_id,
        evidence_status=evidence_status,
        publication_status=publication_status,
        items=artifact_entries(
            evidence_status=snapshot.evidence_status,
            sealed_paths=sealed_paths,
        ),
    )


@router.get(
    "/{artifact_name}",
    response_class=Response,
    responses={
        200: {
            "content": {
                "application/json": {
                    "schema": {
                        "anyOf": [
                            {"type": "object"},
                            {"type": "array", "items": {"type": "object"}},
                        ]
                    }
                },
                "application/x-ndjson": {"schema": {"type": "string"}},
                "text/plain": {"schema": {"type": "string"}},
            }
        },
        404: {"model": ErrorResponse},
        409: {"model": ErrorResponse},
        422: {"model": ErrorResponse},
    },
)
async def download_artifact(
    run_id: str,
    artifact_name: PublicArtifactName,
    dependencies: Dependencies,
) -> Response:
    try:
        dependencies.store.run(run_id)
    except RunNotFound as error:
        raise _run_unknown(run_id) from error
    relative_path = ARTIFACT_PATHS[artifact_name]
    try:
        payload = dependencies.recovery.read_artifact(
            run_id=run_id,
            relative_path=relative_path,
        )
    except ArtifactAccessDenied as error:
        raise _artifact_unverified(run_id) from error
    except ArtifactIntegrityError as error:
        raise _artifact_integrity_failed(run_id) from error
    return Response(
        content=payload,
        media_type=_media_type(relative_path),
        headers={"Content-Disposition": f'attachment; filename="{artifact_name.value}"'},
    )


def _sealed_paths(seal_bytes: bytes) -> frozenset[str]:
    seal = parse_json_object(seal_bytes)
    files = seal.get("files")
    if type(files) is not list:
        raise ValueError("Verified seal inventory is invalid.")
    paths: set[str] = set()
    for item in files:
        if type(item) is not dict:
            raise ValueError("Verified seal inventory is invalid.")
        relative_path = item.get("relative_path")
        if type(relative_path) is not str:
            raise ValueError("Verified seal inventory is invalid.")
        paths.add(relative_path)
    return frozenset(paths)


def _media_type(relative_path: str) -> str:
    if relative_path.endswith(".json"):
        return "application/json"
    if relative_path.endswith(".ndjson"):
        return "application/x-ndjson"
    if relative_path.endswith(".txt"):
        return "text/plain; charset=utf-8"
    raise RuntimeError("Public artifact path has no declared media type.")


def _publication_status(
    evidence_status: EvidenceStatus,
) -> ArtifactPublicationStatus | None:
    if evidence_status == "PENDING":
        return None
    if evidence_status == "UNVERIFIED":
        return "PARTIAL"
    return evidence_status


def _run_unknown(run_id: str) -> ApiError:
    return ApiError(
        status_code=404,
        code="RUN_UNKNOWN",
        message="The run ID is not registered.",
        run_id=run_id,
    )


def _artifact_unverified(run_id: str) -> ApiError:
    return ApiError(
        status_code=409,
        code="ARTIFACT_UNVERIFIED",
        message="Only freshly verified sealed evidence can be downloaded.",
        run_id=run_id,
    )


def _artifact_integrity_failed(run_id: str) -> ApiError:
    return ApiError(
        status_code=409,
        code="ARTIFACT_INTEGRITY_FAILED",
        message="The sealed run root failed fresh integrity verification.",
        run_id=run_id,
    )
