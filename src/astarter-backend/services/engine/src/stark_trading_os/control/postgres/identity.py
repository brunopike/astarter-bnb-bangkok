"""Server-owned opaque grants. Origin and request claims are never identities.

Revocation stops new admissions; an already admitted request may finish. This is
not database-atomic revocation, RLS, or an execution permit. No credential IO.
"""
import re
import time
from dataclasses import dataclass, field
from hashlib import sha256
from hmac import compare_digest
from threading import RLock
from typing import Literal

from stark_trading_os.control.astarter.strategy_repository import ScopeAssignment, _valid


class IdentityRejected(ValueError):
    def __init__(self) -> None:
        super().__init__('IDENTITY_REQUIRED')


@dataclass(frozen=True)
class Grant:
    token_digest: str = field(repr=False)
    subject: str
    scope: ScopeAssignment
    role: Literal['reader', 'writer']
    audience: str
    not_before_ms: int
    expires_at_ms: int

    def __post_init__(self) -> None:
        if (type(self.token_digest) is not str
                or re.fullmatch('[0-9a-f]{64}', self.token_digest) is None
                or type(self.subject) is not str or not 1 <= len(self.subject) <= 128
                or type(self.audience) is not str or not 1 <= len(self.audience) <= 128
                or type(self.role) is not str or self.role not in {'reader', 'writer'}
                or type(self.not_before_ms) is not int or type(self.expires_at_ms) is not int
                or not 0 <= self.not_before_ms < self.expires_at_ms < 2**63):
            raise ValueError('IDENTITY_CONFIGURATION')
        object.__setattr__(self, 'scope', _valid(self.scope, ScopeAssignment))


@dataclass(frozen=True)
class Principal:
    subject: str
    scope: ScopeAssignment
    role: Literal['reader', 'writer']

    def resolve_scope(self) -> ScopeAssignment:
        return self.scope


class IdentityRegistry:
    def __init__(self, audience: str, grants: tuple[Grant, ...]) -> None:
        if (type(audience) is not str or not 1 <= len(audience) <= 128
                or type(grants) is not tuple or not 1 <= len(grants) <= 256
                or any(type(g) is not Grant for g in grants)
                or len({g.token_digest for g in grants}) != len(grants)):
            raise ValueError('IDENTITY_CONFIGURATION')
        self._audience = audience
        self._grants = grants
        self._revoked: set[str] = set()
        self._lock = RLock()

    def revoke(self, token_digest: str) -> None:
        with self._lock:
            self._revoked.add(token_digest)

    def authenticate(self, headers: tuple[str, ...]) -> Principal:
        if (len(headers) != 1 or len(headers[0]) > 263
                or re.fullmatch(r'Bearer [A-Za-z0-9_-]{32,256}', headers[0]) is None):
            raise IdentityRejected
        digest = sha256(headers[0][7:].encode('ascii')).hexdigest()
        now = time.time_ns() // 1_000_000
        selected = None
        with self._lock:
            for grant in self._grants:
                if compare_digest(digest, grant.token_digest):
                    selected = grant
            if (selected is None or selected.token_digest in self._revoked
                    or selected.audience != self._audience
                    or not selected.not_before_ms <= now < selected.expires_at_ms):
                raise IdentityRejected
            return Principal(selected.subject, selected.scope, selected.role)
