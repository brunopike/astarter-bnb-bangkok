"""Six bounded reference-only HTTP actions; no client-derived identity or clock."""
import json
import re
from collections.abc import Callable, Coroutine
from typing import Annotated, Any

from fastapi import APIRouter, Request
from fastapi.encoders import jsonable_encoder
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from pydantic import BaseModel, Field, StrictInt
from starlette.responses import Response

from stark_trading_os.control.astarter import strategy_repository as r
from stark_trading_os.control.postgres.caller import ReferenceCaller, ReferenceRuntime, owned_thread
from stark_trading_os.control.postgres.identity import IdentityRejected
from stark_trading_os.control.postgres.pool import CommitUnknown
from stark_trading_os.control.security import raw_header_values
from stark_trading_os.domain import strategy_contracts as c
from stark_trading_os.integrations.contracts import Identifier
from stark_trading_os.integrations.research_egress import canonical


class SavePlan(c.Offline):
    bundle: c.PreflightInput
    request_key: Identifier
    expected_revision: Identifier | None


class SaveApproval(c.Offline):
    approval: c.ApprovalSnapshot
    request_key: Identifier


class PlanPage(c.Offline):
    after_id: Identifier | None = None
    after_ordinal: Annotated[StrictInt, Field(ge=0)] = 0
    limit: Annotated[StrictInt, Field(ge=1, le=100)] = 100


class PlanRead(c.Offline):
    revision: Identifier | None = None
    approval_id: Identifier | None = None


class RecoveryRead(c.Offline):
    revision: Identifier
    seq: Annotated[StrictInt, Field(gt=0)] | None = None
    approval_id: Identifier | None = None


class ReferenceRoute(APIRoute):
    def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        handler = super().get_route_handler()

        async def guarded(request: Request) -> Response:
            try:
                return await handler(request)
            except IdentityRejected:
                return _error(401, 'IDENTITY_REQUIRED')
            except PermissionError:
                return _error(403, 'REFERENCE_FORBIDDEN')
            except CommitUnknown:
                return _error(503, 'COMMIT_UNKNOWN_NO_RETRY')
            except (LookupError, r.ScopeDenied):
                return _error(404, 'REFERENCE_NOT_FOUND')
            except r.PersistenceConflict:
                return _error(409, 'REFERENCE_CONFLICT')
            except r.StoredReferenceError:
                return _error(503, 'REFERENCE_UNAVAILABLE')
            except (ValueError, TypeError, RecursionError):
                return _error(422, 'REFERENCE_INVALID')
            except Exception:
                # Never expose/log driver repr, validation inputs, IDs or credentials.
                return _error(503, 'REFERENCE_UNAVAILABLE')
        return guarded


router = APIRouter(prefix='/v1/strategy-references', route_class=ReferenceRoute)


def _error(status: int, code: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={
        'code': code, 'retryable': False, 'execution_authorized': False,
    })


def _caller(request: Request, *, write: bool = False) -> ReferenceCaller:
    runtime = request.app.state.strategy_reference_runtime
    if not isinstance(runtime, ReferenceRuntime):
        raise RuntimeError('REFERENCE_UNAVAILABLE')
    return runtime.admit(raw_header_values(request, 'authorization'), write=write)


def _pairs(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('REFERENCE_INVALID')
        result[key] = value
    return result


async def _body[T: BaseModel](request: Request, cls: type[T]) -> T:
    raw = bytearray()
    async for chunk in request.stream():
        raw.extend(chunk)
        if len(raw) > 262144:
            raise ValueError('REFERENCE_INVALID')
    tree = r._json_tree(json.loads(raw, object_pairs_hook=_pairs))
    # Validate the untouched JSON scalar tree strictly before canonical revalidation.
    value = cls.model_validate(tree, strict=True)
    return canonical(value, cls, extra=(*r._TYPES, SavePlan, SaveApproval))


def _query[T: BaseModel](request: Request, cls: type[T]) -> T:
    pairs = request.query_params.multi_items()
    values: dict[str, object] = _pairs(list(pairs))
    for key in ('limit', 'after_ordinal', 'seq'):
        if key in values:
            text = values[key]
            if type(text) is not str or re.fullmatch(r'0|[1-9][0-9]{0,9}', text) is None:
                raise ValueError('REFERENCE_INVALID')
            values[key] = int(text)
    return cls.model_validate(values, strict=True)


def _id(value: str) -> str:
    # Use the original Identifier contract, not a second permissive URL grammar.
    class PathIdentifier(c.Offline):
        value: Identifier
    return PathIdentifier(value=value).value


async def _result(call: Callable[[], object]) -> JSONResponse:
    value = await owned_thread(call)
    return JSONResponse(content={
        'reference_only': True, 'execution_authorized': False,
        'result': jsonable_encoder(value),
    })


@router.get('/plans')
async def list_plans(request: Request) -> JSONResponse:
    caller = _caller(request)
    page = _query(request, PlanPage)
    return await _result(lambda: caller.list_plans(
        after=(page.after_id or '', page.after_ordinal), limit=page.limit))


@router.get('/plans/{plan_id}')
async def read_plan(request: Request, plan_id: str) -> JSONResponse:
    caller = _caller(request)
    plan_id = _id(plan_id)
    query = _query(request, PlanRead)
    return await _result(lambda: caller.read_plan(plan_id, revision=query.revision,
                                                 approval_id=query.approval_id))


@router.post('/plans')
async def save_plan(request: Request) -> JSONResponse:
    caller = _caller(request, write=True)
    _query(request, c.Offline)
    body = await _body(request, SavePlan)
    return await _result(lambda: caller.save_plan(body.bundle, request_key=body.request_key,
                                                 expected_revision=body.expected_revision))


@router.post('/plans/{plan_id}/approval-references')
async def save_approval(request: Request, plan_id: str) -> JSONResponse:
    caller = _caller(request, write=True)
    plan_id = _id(plan_id)
    _query(request, c.Offline)
    body = await _body(request, SaveApproval)
    return await _result(lambda: caller.save_approval(plan_id, body.approval,
                                                     request_key=body.request_key))


@router.post('/recovery')
async def save_recovery(request: Request) -> JSONResponse:
    caller = _caller(request, write=True)
    _query(request, c.Offline)
    body = await _body(request, r.RecoveryCheckpoint)
    return await _result(lambda: caller.save_recovery(body))


@router.get('/plans/{plan_id}/recovery')
async def read_recovery(request: Request, plan_id: str) -> JSONResponse:
    caller = _caller(request)
    plan_id = _id(plan_id)
    query = _query(request, RecoveryRead)
    return await _result(lambda: caller.read_recovery(plan_id, query.revision,
                                                     seq=query.seq, approval_id=query.approval_id))
