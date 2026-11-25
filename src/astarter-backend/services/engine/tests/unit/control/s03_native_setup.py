"""Explicit trusted test host; identity never comes from persisted account rows."""

from dataclasses import replace
from hashlib import sha256

from stark_trading_os.control.s03_bridge import S03BridgeControl
from stark_trading_os.runner.s03_simulation import S03ControllerBackend


def s03_bridge(store, source):
    backend = S03ControllerBackend.for_source(source)
    identity = replace(
        backend.identity,
        owner_id="s03-test-" + sha256(source.venue_session.encode()).hexdigest()[:24]
    )
    control = S03ControllerBackend(identity).control(store)
    return S03BridgeControl(store, control=control)
