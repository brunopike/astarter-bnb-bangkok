"""Service-specific metadata compatibility before the unchanged strict policy.

BlockBeats duplicate Vary rejects wildcard/empty members conservatively (RFC 9110
permits wildcard members). CoinGecko duplicate STS retains only the first field,
following RFC 6797 section 8.1; this is not an HSTS storage/enforcement engine.
No other field, service, encoding, framing or response-body limit gains an exception.
"""

from __future__ import annotations

from stark_trading_os.integrations.http_policy import (
    _HEADER_NAME,
    MAX_HEADER_BYTES,
    MAX_HEADER_COUNT,
)
from stark_trading_os.integrations.http_policy import (
    response_headers as strict_response_headers,
)
from stark_trading_os.integrations.transport import TransportReason, TransportRejected


def public_response_headers(
    service: str, raw: list[tuple[bytes, bytes]]
) -> tuple[int | None, tuple[tuple[str, str], ...]]:
    if service not in {"BLOCKBEATS_NEWS", "COINGECKO_ASSETS"}:
        return strict_response_headers(raw)
    field = b"vary" if service == "BLOCKBEATS_NEWS" else b"strict-transport-security"
    reject = TransportRejected(TransportReason.RESPONSE)
    # Check the entire original input before folding can reduce its totals or
    # strip whitespace. Original raw-header count/size guards still apply.
    if len(raw) > MAX_HEADER_COUNT or sum(len(k) + len(v) + 4 for k, v in raw) > MAX_HEADER_BYTES:
        raise reject
    if sum(name.lower() == field for name, _ in raw) < 2:
        return strict_response_headers(raw)

    seen: set[bytes] = set()
    values: list[bytes] = []
    for name, value in raw:
        if not _HEADER_NAME.fullmatch(name) or any(b < 32 or b > 126 for b in value):
            raise reject
        key = name.lower()
        if key in seen and key not in {field, b"set-cookie"}:
            raise reject
        seen.add(key)
        if key == field == b"vary":
            members = [member.strip() for member in value.split(b",")]
            if any(member == b"*" or not _HEADER_NAME.fullmatch(member) for member in members):
                raise reject
            values.append(value.strip())

    combined = b", ".join(values)
    folded: list[tuple[bytes, bytes]] = []
    emitted = False
    for name, value in raw:
        if name.lower() != field:
            folded.append((name, value))
        elif not emitted:
            # Keep first name/position; join only Vary, never STS. The entire
            # original input (including discarded STS values) was checked above.
            folded.append((name, combined if field == b"vary" else value))
            emitted = True
    return strict_response_headers(folded)
