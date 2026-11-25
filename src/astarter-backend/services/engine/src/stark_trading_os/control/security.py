"""Strict loopback-origin policy for the non-proxy control API."""

from __future__ import annotations

import ipaddress
from urllib.parse import urlsplit

from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.responses import JSONResponse, Response
from starlette.types import ASGIApp

_FORWARDED_HEADERS = frozenset({"forwarded", "x-forwarded-host", "x-forwarded-proto"})


class InvalidLocalOrigin(ValueError):
    """Configured BFF origin is not one exact HTTP loopback origin."""


def validate_local_origin(value: str | None) -> str:
    if value is None or not value:
        raise InvalidLocalOrigin("WEB_LOCAL_ORIGIN is required.")
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as error:
        raise InvalidLocalOrigin("WEB_LOCAL_ORIGIN is invalid.") from error
    if (
        parsed.scheme != "http"
        or not parsed.netloc
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path
        or parsed.query
        or parsed.fragment
        or parsed.hostname is None
    ):
        raise InvalidLocalOrigin("WEB_LOCAL_ORIGIN must be an exact HTTP loopback origin.")
    hostname = parsed.hostname
    loopback = hostname == "localhost"
    if not loopback:
        try:
            loopback = ipaddress.ip_address(hostname).is_loopback
        except ValueError:
            loopback = False
    if not loopback:
        raise InvalidLocalOrigin("WEB_LOCAL_ORIGIN host must be loopback.")
    canonical_netloc = parsed.hostname
    if ":" in canonical_netloc:
        canonical_netloc = f"[{canonical_netloc}]"
    if port is not None:
        canonical_netloc = f"{canonical_netloc}:{port}"
    if value != f"http://{canonical_netloc}":
        raise InvalidLocalOrigin("WEB_LOCAL_ORIGIN must not contain extra URL components.")
    return value


def raw_header_values(request: Request, name: str) -> tuple[str, ...]:
    encoded = name.lower().encode("ascii")
    return tuple(
        value.decode("latin-1")
        for header_name, value in request.scope["headers"]
        if header_name.lower() == encoded
    )


class LocalOriginMiddleware(BaseHTTPMiddleware):
    def __init__(self, app: ASGIApp, *, allowed_origin: str) -> None:
        super().__init__(app)
        self._allowed_origin = validate_local_origin(allowed_origin)

    async def dispatch(
        self,
        request: Request,
        call_next: RequestResponseEndpoint,
    ) -> Response:
        raw_headers = tuple(
            (name.decode("latin-1").lower(), value.decode("latin-1"))
            for name, value in request.scope["headers"]
        )
        if any(name in _FORWARDED_HEADERS for name, _value in raw_headers):
            return _security_error(
                status_code=400,
                code="FORWARDED_HEADER_FORBIDDEN",
                message="Proxy-derived authority headers are not accepted.",
            )
        origins = tuple(value for name, value in raw_headers if name == "origin")
        if origins != (self._allowed_origin,):
            return _security_error(
                status_code=403,
                code="ORIGIN_FORBIDDEN",
                message="The request Origin is not the configured local BFF origin.",
            )
        return await call_next(request)


def _security_error(*, status_code: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(
        status_code=status_code,
        content={
            "code": code,
            "message": message,
            "run_id": None,
            "retryable": False,
            "evidence_id": None,
            "details": None,
        },
    )
