"""Real Psycopg sockets/pool against a local, synthetic PostgreSQL wire peer."""
import asyncio
import socket
import struct
import tempfile
import threading
import time
from collections import deque
from contextlib import contextmanager
from pathlib import Path
from socketserver import BaseRequestHandler, ThreadingUnixStreamServer

import psycopg
import pytest
from psycopg.pq import TransactionStatus
from psycopg_pool import PoolTimeout

from stark_trading_os.control.postgres import pool as module
from stark_trading_os.control.postgres.pool import (
    PersistenceUnavailable,
    PgRepositoryPool,
    PoolSettings,
)


def frame(tag, payload):
    return tag + struct.pack('!I', len(payload) + 4) + payload


def receive(sock, length):
    data = bytearray()
    while len(data) < length:
        part = sock.recv(length - len(data))
        if not part:
            raise EOFError
        data.extend(part)
    return bytes(data)


@contextmanager
def wire_pool(actions, *, timeout=0.12, size=1):
    """No DNS/TCP/database/credentials: Unix socket, synthetic LOGIN, empty queries only."""
    actions = deque(actions)
    sockets, workers, connections, queries = [], [], [], []
    stopped = threading.Event()

    class Peer(BaseRequestHandler):
        def handle(self):
            workers.append(threading.current_thread())
            sockets.append(self.request)
            self.request.settimeout(2)
            try:
                length = struct.unpack('!I', receive(self.request, 4))[0]
                assert 8 <= length <= 4096
                receive(self.request, length - 4)
                self.request.sendall(frame(b'R', struct.pack('!I', 0))
                                     + frame(b'S', b'client_encoding\0UTF8\0')
                                     + frame(b'S', b'server_version\00017.11\0')
                                     + frame(b'Z', b'I'))
                while not stopped.is_set():
                    tag = receive(self.request, 1)
                    length = struct.unpack('!I', receive(self.request, 4))[0]
                    payload = receive(self.request, length - 4)
                    if tag == b'X':
                        return
                    queries.append((tag, payload))
                    assert (tag, payload) == (b'Q', b'\0')
                    action = actions.popleft() if actions else 'ok'
                    if action == 'drop':
                        return
                    if action == 'silent':
                        continue  # Deliberate half-open peer: never acknowledge the probe.
                    if action == 'slow':
                        stopped.wait(0.4)
                    if action == 'wrong':
                        self.request.sendall(frame(b'C', b'SELECT 1\0') + frame(b'Z', b'I'))
                        continue
                    self.request.sendall(frame(b'I', b'') + frame(b'Z', b'I'))
            except (EOFError, OSError):
                pass

    class RecordedConnection(psycopg.Connection):
        @classmethod
        def connect(cls, *args, **kwargs):
            c = super().connect(*args, **kwargs)
            connections.append(c)
            return c

    # Short Unix paths also work on macOS's sockaddr_un limit.
    with tempfile.TemporaryDirectory(prefix='pg-wire-', dir='/tmp') as directory:
        address = str(Path(directory) / '.s.PGSQL.55439')
        with ThreadingUnixStreamServer(address, Peer) as server:
            thread = threading.Thread(target=server.serve_forever,
                                      kwargs={'poll_interval': 0.01})
            thread.start()
            p = PgRepositoryPool(
                f'host={directory} port=55439 dbname=synthetic user=synthetic '
                'sslmode=disable passfile=/dev/null',
                settings=PoolSettings(max_size=size, acquire_timeout=timeout,
                                      connect_timeout=1, check_on_checkout=True),
            )
            p._pool.connection_class = RecordedConnection
            p._pool.open()  # This peer tests checkout, never pretends to pass the ACL handshake.
            try:
                yield p, connections, queries
            finally:
                p.close()
                stopped.set()
                server.shutdown()
                for sock in sockets:
                    try:
                        sock.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass
                thread.join(2)
        assert not thread.is_alive() and all(not w.is_alive() for w in workers)
        assert all(c.closed for c in connections)


def test_native_drop_is_replaced_and_healthy_connection_reused():
    with wire_pool(['drop', 'ok', 'ok']) as (p, connections, queries):
        with p._connection() as first:
            assert first.pgconn.transaction_status == TransactionStatus.IDLE
        with p._connection() as second:
            assert second is first
        assert len(connections) == 2 and connections[0].closed
        assert len(queries) == 3
        assert p._pool.get_stats()['pool_available'] == 1


@pytest.mark.parametrize('action', ['silent', 'slow'])
def test_native_silent_or_late_reply_is_bounded_discarded_and_next_request_recovers(action):
    with wire_pool([action, 'ok']) as (p, connections, queries):
        started = time.monotonic()
        with pytest.raises(PoolTimeout):
            with p._connection():
                pytest.fail('Unacknowledged connection must never reach the caller')
        elapsed = time.monotonic() - started
        assert 0.09 <= elapsed < 0.30  # Original delayed reply takes 0.4 seconds.
        assert connections[0].closed
        with p._connection() as recovered:
            assert recovered is not connections[0]
        assert len(queries) == 2
        assert p._pool.get_stats()['pool_available'] == 1


@pytest.mark.parametrize('cancel', [asyncio.CancelledError, KeyboardInterrupt])
def test_cancel_during_probe_closes_returns_without_retry(monkeypatch, cancel):
    with wire_pool(['ok']) as (p, connections, _):
        native_wait = module.waiting.wait
        def interrupted(*args, **kwargs):
            raise cancel()
        with monkeypatch.context() as patch:
            patch.setattr(module.waiting, 'wait', interrupted)
            with pytest.raises(cancel):
                with p._connection():
                    pytest.fail('Cancellation must propagate')
        assert module.waiting.wait is native_wait
        assert connections[0].closed
        with p._connection() as recovered:
            assert recovered is not connections[0]
        assert p._pool.get_stats()['pool_available'] == 1


def test_pool_wait_and_probe_share_one_deadline():
    with wire_pool(['slow'], timeout=0.20) as (p, connections, _):
        held = p._pool.getconn()
        returned = threading.Thread(target=lambda: (time.sleep(0.12), p._pool.putconn(held)))
        returned.start()
        try:
            start = time.monotonic()
            with pytest.raises(PoolTimeout):
                with p._connection():
                    pytest.fail('Wait must not receive a fresh probe budget')
            assert 0.17 <= time.monotonic() - start < 0.29
            assert connections[0].closed
        finally:
            returned.join(2)


def test_caller_exception_returns_connection_once_without_replay():
    with wire_pool(['ok', 'ok']) as (p, connections, queries):
        calls = 0
        with pytest.raises(ValueError, match='caller-error'):
            with p._connection():
                calls += 1
                raise ValueError('caller-error')
        assert calls == 1 and len(queries) == 1
        with p._connection() as second:
            assert second is connections[0]
        assert p._pool.get_stats()['pool_available'] == 1


def test_malformed_probe_response_is_not_admitted():
    with wire_pool(['wrong', 'ok']) as (p, connections, _):
        with p._connection() as good:
            assert good is not connections[0]
        assert connections[0].closed


def test_two_failed_probes_stop_before_another_connection_is_admitted():
    with wire_pool(['drop'] * 4 + ['ok']) as (p, connections, queries):
        with pytest.raises(PersistenceUnavailable, match='PG2_CHECKOUT_FAILED'):
            with p._connection():
                pytest.fail('Do not repeatedly reconnect until an eventual good peer appears')
        assert len(queries) == 2
        assert all(c.closed for c in connections[:2])


def test_concurrent_waiter_times_out_without_taking_or_closing_borrowed_connection():
    with wire_pool(['ok', 'ok']) as (p, connections, _):
        with p._connection() as held:
            with pytest.raises(PoolTimeout):
                with p._connection():
                    pytest.fail('Pool max_size must remain enforced')
            assert not held.closed
        with p._connection() as recovered:
            assert recovered is held
        assert len(connections) == 1


def test_actual_shared_caller_cancellation_drains_probe_and_releases_slot():
    from stark_trading_os.control.public_data_shared import _OwnedCalls

    with wire_pool(['silent', 'ok']) as (p, connections, queries):
        def read():
            with p._connection():
                return 'read'

        async def scenario():
            calls = _OwnedCalls()
            task = asyncio.create_task(calls.run(read))
            async with asyncio.timeout(1):
                while not queries:
                    await asyncio.sleep(0.001)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            assert calls.pending  # Cancellation cannot abandon a running DAL call.
            async with asyncio.timeout(0.4):
                while calls.pending:
                    await asyncio.sleep(0.001)
            assert connections[0].closed
            assert await calls.run(read) == 'read'
            await calls.close()
            assert not calls.pending and calls.slots._value == 4

        asyncio.run(scenario())


def test_shared_caller_cancel_while_queued_does_not_abandon_native_waiter():
    from stark_trading_os.control.public_data_shared import _OwnedCalls

    with wire_pool(['ok']) as (p, _, _):
        held = p._pool.getconn()

        def read():
            with p._connection():
                return 'read'

        async def scenario():
            calls = _OwnedCalls()
            task = asyncio.create_task(calls.run(read))
            async with asyncio.timeout(1):
                while p._pool.get_stats()['requests_waiting'] != 1:
                    await asyncio.sleep(0.001)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            assert calls.pending
            async with asyncio.timeout(0.4):
                while calls.pending:
                    await asyncio.sleep(0.001)
            assert not held.closed
            p._pool.putconn(held)
            assert await calls.run(read) == 'read'
            await calls.close()
            assert calls.slots._value == 4 and not calls.pending

        asyncio.run(scenario())


@pytest.mark.parametrize('value', [1, None, 'true'])
def test_checkout_configuration_is_explicit_boolean(value):
    with pytest.raises(ValueError, match='POOL_BOUNDS'):
        PoolSettings(check_on_checkout=value)
    assert PoolSettings().check_on_checkout is False
