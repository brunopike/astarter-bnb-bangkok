"""Fixed server-to-server PRIVATE RPC. Import/default factory performs no IO."""

import asyncio
import hmac
import json
import math
import re
from typing import Any, Protocol

from fastapi import FastAPI, Request
from fastapi.responses import Response
from starlette.exceptions import HTTPException
from starlette.requests import ClientDisconnect

from .postgres.caller import owned_thread
from .postgres.pool import CommitUnknown
from .postgres.private_research_contracts import CONTRACT

BASE = "/internal/private/v1"
MAX_BODY = 65_536
MAX_RESULT = 131_072
RUNTIME_METHODS = frozenset(
    {"lease", "session/resolve", "research/get", "research/claim", "research/finish",
     "notifications/state", "notifications/command", "notifications/request",
     "workspace/state", "workspace/save", "workspace/request",
     "drafts/preview", "drafts/get", "drafts/adopt", "drafts/request"}
)
ISSUER_METHODS = frozenset(
    {
        "auth/challenge/issue",
        "auth/challenge/get",
        "auth/challenge/prepare",
        "auth/challenge/consume",
        "auth/challenge/revoke",
        "auth/session/issue",
        "auth/session/resolve",
        "auth/session/revoke",
    }
)
ERRORS = {
    "PRIVATE_AUTH_REQUIRED": 401,
    "PRIVATE_FORBIDDEN": 403,
    "PRIVATE_TARGET_MISMATCH": 403,
    "PRIVATE_REQUEST_INVALID": 400,
    "PRIVATE_CONFLICT": 409,
    "BUDGET_EXCEEDED": 409,
    "PRIVATE_UNAVAILABLE": 503,
    "PRIVATE_COMMIT_UNKNOWN": 409,
}


class PrivateRPCError(Exception):
    def __init__(self, code: str) -> None:
        if code not in ERRORS:
            raise ValueError("PRIVATE_ERROR_CONFIGURATION")
        self.code = code
        super().__init__(code)


class PrivateRPCBackend(Protocol):
    """Native DAL owns fixed SQL, real identity, time, transaction and bounded pool."""

    def invoke(
        self, operation: str, payload: dict[str, Any], session_digest: str | None
    ) -> Any: ...


def _response(status: int, *, code: str | None = None, result: Any = None) -> Response:
    value = (
        {"contract": CONTRACT, "code": code} if code else {"contract": CONTRACT, "result": result}
    )
    try:
        body = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode(
            "utf-8"
        )
        if len(body) > MAX_RESULT:
            raise ValueError("PRIVATE_RESULT_SIZE")
    except (TypeError, ValueError, RecursionError, UnicodeError):
        return _response(500, code="PRIVATE_RESULT_INVALID")
    return Response(
        body,
        status_code=status,
        media_type="application/json",
        headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"},
    )


def _unique(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("PRIVATE_DUPLICATE_FIELD")
        result[key] = value
    return result


def _constant(_: str) -> None:
    raise ValueError("PRIVATE_NONFINITE_JSON")


def _float(value: str) -> float:
    result = float(value)
    if not math.isfinite(result):
        raise ValueError("PRIVATE_NONFINITE_JSON")
    return result


def _header(request: Request, name: str) -> str | None:
    values = request.headers.getlist(name)
    return values[0] if len(values) == 1 else None


def create_private_research_app(
    *,
    runtime: PrivateRPCBackend | None = None,
    issuer: PrivateRPCBackend | None = None,
    runtime_secret: str | None = None,
    issuer_secret: str | None = None,
) -> FastAPI:
    configured = all(
        value is not None for value in (runtime, issuer, runtime_secret, issuer_secret)
    )
    if configured and (
        runtime is issuer
        or runtime_secret == issuer_secret
        or any(
            type(secret) is not str or not re.fullmatch(r"[A-Za-z0-9_-]{32,256}", secret)
            for secret in (runtime_secret, issuer_secret)
        )
    ):
        raise ValueError("PRIVATE_CONFIGURATION")
    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
    active = asyncio.Semaphore(16)

    @app.exception_handler(HTTPException)
    async def http_error(_: Request, error: HTTPException) -> Response:
        return _response(error.status_code, code="PRIVATE_REQUEST_INVALID")

    @app.post(BASE + "/{operation:path}")
    async def rpc(operation: str, request: Request) -> Response:
        if operation not in RUNTIME_METHODS | ISSUER_METHODS:
            return _response(404, code="PRIVATE_REQUEST_INVALID")
        if not configured:
            return _response(503, code="PRIVATE_UNCONFIGURED")
        is_runtime = operation in RUNTIME_METHODS
        backend = runtime if is_runtime else issuer
        secret = runtime_secret if is_runtime else issuer_secret
        assert backend is not None and secret is not None
        auth = _header(request, "authorization")
        if auth is None or not hmac.compare_digest(auth.encode(), ("Bearer " + secret).encode()):
            return _response(401, code="PRIVATE_AUTH_REQUIRED")
        session_digest = _header(request, "x-astarter-private-session-digest")
        if is_runtime and (
            session_digest is None or re.fullmatch(r"[a-f0-9]{64}", session_digest) is None
        ):
            return _response(401, code="PRIVATE_AUTH_REQUIRED")
        if request.url.query or (
            not is_runtime and request.headers.getlist("x-astarter-private-session-digest")
        ):
            return _response(400, code="PRIVATE_REQUEST_INVALID")
        content_type = _header(request, "content-type")
        if not content_type or content_type.split(";")[0].strip().lower() != "application/json":
            return _response(415, code="PRIVATE_REQUEST_INVALID")
        length = _header(request, "content-length")
        if request.headers.getlist("content-length") and (
            length is None or len(length) > 6 or not length.isascii() or not length.isdecimal()
        ):
            return _response(400, code="PRIVATE_REQUEST_INVALID")
        if length is not None and int(length) > MAX_BODY:
            return _response(413, code="PRIVATE_BODY_TOO_LARGE")
        try:
            body = bytearray()
            async with asyncio.timeout(5):
                async for chunk in request.stream():
                    if len(body) + len(chunk) > MAX_BODY:
                        return _response(413, code="PRIVATE_BODY_TOO_LARGE")
                    body.extend(chunk)
            payload = json.loads(
                body.decode("utf-8"),
                object_pairs_hook=_unique,
                parse_constant=_constant,
                parse_float=_float,
            )
            if type(payload) is not dict:
                raise ValueError("PRIVATE_REQUEST_SHAPE")
            if (
                is_runtime
                and operation == "session/resolve"
                and (payload.get("tokenDigest") != session_digest)
            ):
                return _response(401, code="PRIVATE_AUTH_REQUIRED")
        except (ValueError, RecursionError, TimeoutError, ClientDisconnect):
            return _response(400, code="PRIVATE_REQUEST_INVALID")
        if active.locked():
            return _response(503, code="PRIVATE_UNAVAILABLE")
        try:
            async with active:
                # owned_thread drains bounded native work before cancellation releases capacity.
                result = await owned_thread(
                    lambda: backend.invoke(operation, payload, session_digest)
                )
            return _response(200, result=result)
        except PrivateRPCError as error:
            return _response(ERRORS[error.code], code=error.code)
        except CommitUnknown:
            return _response(409, code="PRIVATE_COMMIT_UNKNOWN")
        except PermissionError:
            return _response(403, code="PRIVATE_FORBIDDEN")
        except ValueError:
            return _response(400, code="PRIVATE_REQUEST_INVALID")
        except Exception:
            return _response(503, code="PRIVATE_UNAVAILABLE")

    return app
