"""Lossless lexical normalization; no prices, units or permissions are inferred."""

from __future__ import annotations

import re
from fractions import Fraction
from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, StrictStr, model_validator

_SOURCE = re.compile(r"(?:0|[1-9][0-9]*)(?:\.[0-9]+)?", re.ASCII)
CanonicalDecimal = Annotated[
    StrictStr, Field(max_length=64, pattern=r"^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$")
]
type Domain = Literal["nonnegative", "positive", "step", "rate"]


class DecimalRejected(ValueError):
    def __init__(self) -> None:
        super().__init__("DECIMAL_INPUT_INVALID")


def normalize_decimal_text(raw: object, *, domain: Domain = "nonnegative") -> str:
    if type(raw) is not str or not 0 < len(raw) <= 128 or _SOURCE.fullmatch(raw) is None:
        raise DecimalRejected
    value = raw.rstrip("0").rstrip(".") if "." in raw else raw
    if len(value) > 64 or domain not in {"nonnegative", "positive", "step", "rate"}:
        raise DecimalRejected
    exact = Fraction(value)
    if (domain in {"positive", "step"} and exact <= 0) or (domain == "rate" and exact > 1):
        raise DecimalRejected
    return value


class DecimalValue(BaseModel):
    model_config = ConfigDict(
        extra="forbid", strict=True, frozen=True, revalidate_instances="always"
    )
    raw: StrictStr = Field(repr=False, max_length=128)
    canonical: CanonicalDecimal

    @model_validator(mode="after")
    def lossless(self) -> Self:
        if normalize_decimal_text(self.raw) != self.canonical:
            raise DecimalRejected
        return self

    @classmethod
    def from_raw(cls, raw: object) -> DecimalValue:
        normalized = normalize_decimal_text(raw)
        assert isinstance(raw, str)
        return cls(raw=raw, canonical=normalized)

    def exact(self) -> Fraction:
        validated = type(self).model_validate(self)
        return Fraction(validated.canonical)
