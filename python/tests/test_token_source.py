"""TokenSource — fetch/cache/refresh semantics for the third credential
kind. The cache decision table mirrors the cross-SDK contract in
``token-source-vectors.json``."""

from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Mapping

import httpx
import pytest

from cosmo_ai import CredentialsError, CredentialsErrorCode, RealtimeClient, MintedToken, TokenSource
from cosmo_ai._internal.protocol import (
    _sdk_info,
    InlineAgentConfig,
    SessionConfig,
    SessionParams,
)
from cosmo_ai.errors import (
    MintTokenError,
    MintTokenErrorCode,
    SessionStartError,
    TokenSourceError,
    TokenSourceErrorCode,
)

Handler = Callable[[httpx.Request], httpx.Response]

TOKEN_URL = "https://myapp.example.com/token"


def _expiry_dt(seconds: float) -> datetime:
    return datetime.now(timezone.utc) + timedelta(seconds=seconds)


def _expiry(seconds: float) -> str:
    return _expiry_dt(seconds).isoformat()


def _mint_json(expires_in_s: float, jwt: str = "jwt-1") -> dict[str, str]:
    return {"jwt": jwt, "expires_at": _expiry(expires_in_s)}


def _route_endpoint_fetches(
    monkeypatch: pytest.MonkeyPatch, handler: Handler
) -> None:
    """Route the short-lived clients ``TokenSource.endpoint`` opens per fetch
    through a mock transport (the Python analog of the TS suite's mocked
    global ``fetch``). Explicit-transport clients are untouched."""
    real_client = httpx.AsyncClient

    def factory(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        kwargs.setdefault("transport", httpx.MockTransport(handler))
        return real_client(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", factory)


# ── TokenSource.endpoint wire shape ────────────────────────────────────────


def test_endpoint_posts_empty_json_body_and_parses_minted_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["method"] = request.method
        captured["url"] = str(request.url)
        captured["content_type"] = request.headers.get("content-type")
        captured["body"] = request.content.decode()
        return httpx.Response(200, json=_mint_json(86_400, jwt="jwt-day"))

    _route_endpoint_fetches(monkeypatch, handler)
    jwt = asyncio.run(TokenSource.endpoint(TOKEN_URL)._get_jwt())

    assert jwt == "jwt-day"
    assert captured["method"] == "POST"
    assert captured["url"] == TOKEN_URL
    assert captured["content_type"] == "application/json"
    assert json.loads(captured["body"]) == {}


def test_endpoint_accepts_serialized_minted_token_spelling(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _route_endpoint_fetches(
        monkeypatch,
        lambda _r: httpx.Response(
            200, json={"jwt": "jwt-alias", "expiresAt": _expiry(86_400)}
        ),
    )
    assert asyncio.run(TokenSource.endpoint(TOKEN_URL)._get_jwt()) == "jwt-alias"


def test_endpoint_refuses_redirects(monkeypatch: pytest.MonkeyPatch) -> None:
    _route_endpoint_fetches(
        monkeypatch,
        lambda _r: httpx.Response(302, headers={"location": "http://evil.example.com"}),
    )
    with pytest.raises(TokenSourceError) as exc_info:
        asyncio.run(TokenSource.endpoint(TOKEN_URL)._get_jwt())
    # A refused redirect never reached a token endpoint, so it is a failed
    # request rather than a rejection — and carries no server slug.
    assert exc_info.value.code is TokenSourceErrorCode.REQUEST_FAILED
    assert exc_info.value.server_code is None
    assert "evil.example.com" in exc_info.value.message


@pytest.mark.parametrize(
    "url",
    [
        "http://myapp.example.com/token",
        "ftp://localhost/token",
        "ws://localhost:8787/token",
    ],
)
def test_endpoint_refuses_insecure_or_foreign_scheme_at_construction(url: str) -> None:
    # Refused before any request, so it is a credential the SDK will not send
    # rather than a request that failed. CredentialsError is a ValueError, so
    # the code is what pins that.
    with pytest.raises(CredentialsError, match="https") as caught:
        TokenSource.endpoint(url)
    assert caught.value.code is CredentialsErrorCode.INSECURE_BASE_URL


def test_endpoint_accepts_https_and_loopback_http() -> None:
    TokenSource.endpoint("https://myapp.example.com/token")
    TokenSource.endpoint("http://localhost:8787/token")
    TokenSource.endpoint("http://127.0.0.1:8787/token")
    TokenSource.endpoint("http://[::1]:8787/token")


def test_concurrent_callers_share_one_failed_fetch() -> None:
    calls = 0

    async def fetch() -> MintedToken:
        nonlocal calls
        calls += 1
        await asyncio.sleep(0)
        raise TokenSourceError(code=TokenSourceErrorCode.REQUEST_FAILED, message="down")

    async def run() -> None:
        source = TokenSource.custom(fetch)
        results = await asyncio.gather(
            source._get_jwt(), source._get_jwt(), return_exceptions=True
        )
        assert all(isinstance(r, TokenSourceError) for r in results)

    asyncio.run(run())
    assert calls == 1


def test_endpoint_attaches_static_headers(monkeypatch: pytest.MonkeyPatch) -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["auth"] = request.headers.get("authorization")
        return httpx.Response(200, json=_mint_json(86_400))

    _route_endpoint_fetches(monkeypatch, handler)
    asyncio.run(
        TokenSource.endpoint(
            TOKEN_URL, headers={"Authorization": "Bearer app-session"}
        )._get_jwt()
    )
    assert captured["auth"] == "Bearer app-session"


@pytest.mark.parametrize("style", ["sync", "async"])
def test_endpoint_resolves_callable_headers_per_fetch(
    monkeypatch: pytest.MonkeyPatch, style: str
) -> None:
    captured: dict[str, Any] = {}
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        captured["header"] = request.headers.get("x-app-auth")
        return httpx.Response(200, json=_mint_json(86_400))

    def sync_headers() -> Mapping[str, str]:
        nonlocal calls
        calls += 1
        return {"X-App-Auth": f"nonce-{calls}"}

    async def async_headers() -> Mapping[str, str]:
        return sync_headers()

    _route_endpoint_fetches(monkeypatch, handler)
    source = TokenSource.endpoint(
        TOKEN_URL, headers=sync_headers if style == "sync" else async_headers
    )
    asyncio.run(source._get_jwt())

    assert calls == 1
    assert captured["header"] == "nonce-1"


def test_endpoint_surfaces_server_slug_on_parseable_rejection(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            403, json={"error": {"type": "api_error", "message": "nope"}}
        )

    _route_endpoint_fetches(monkeypatch, handler)
    with pytest.raises(TokenSourceError) as exc:
        asyncio.run(TokenSource.endpoint(TOKEN_URL)._get_jwt())
    assert exc.value.code is TokenSourceErrorCode.REQUEST_REJECTED
    assert exc.value.server_code == "api_error"


def _raise_connect_error(request: httpx.Request) -> httpx.Response:
    raise httpx.ConnectError("connection refused")


@pytest.mark.parametrize(
    ("handler", "expected"),
    [
        (_raise_connect_error, TokenSourceErrorCode.REQUEST_FAILED),
        (
            lambda request: httpx.Response(200, text="not json"),
            TokenSourceErrorCode.INVALID_RESPONSE,
        ),
        (
            lambda request: httpx.Response(200, json={"jwt": ""}),
            TokenSourceErrorCode.INVALID_RESPONSE,
        ),
    ],
    ids=["transport_failure", "non_json_success_body", "missing_jwt_expires_at"],
)
def test_endpoint_failures_carry_the_code_for_what_failed(
    monkeypatch: pytest.MonkeyPatch, handler: Handler, expected: TokenSourceErrorCode
) -> None:
    # Never reaching the endpoint and the endpoint answering with something
    # that is not a token are different problems with different fixes.
    _route_endpoint_fetches(monkeypatch, handler)
    with pytest.raises(TokenSourceError) as exc:
        asyncio.run(TokenSource.endpoint(TOKEN_URL)._get_jwt())
    assert exc.value.code is expected


# ── TokenSource.custom ─────────────────────────────────────────────────────


def test_custom_accepts_a_minted_token() -> None:
    async def as_datetime() -> MintedToken:
        return MintedToken(
            jwt="j0", expires_at=datetime.now(timezone.utc) + timedelta(days=1)
        )

    async def as_string_expiry() -> MintedToken:
        # The model's own coercion parses the RFC 3339 string a proxied mint
        # response carries.
        return MintedToken.model_validate({"jwt": "j1", "expires_at": _expiry(86_400)})

    async def scenario() -> list[str]:
        return [
            await TokenSource.custom(as_datetime)._get_jwt(),
            await TokenSource.custom(as_string_expiry)._get_jwt(),
        ]

    assert asyncio.run(scenario()) == ["j0", "j1"]


def test_direct_construction_validates_like_custom() -> None:
    async def fetch() -> MintedToken:
        return MintedToken(jwt="", expires_at=_expiry_dt(86_400))

    with pytest.raises(TokenSourceError) as exc:
        asyncio.run(TokenSource(fetch)._get_jwt())
    assert exc.value.code is TokenSourceErrorCode.FETCHER_FAILED


@pytest.mark.parametrize(
    "result",
    [
        {"jwt": "j", "expires_at": "2026-08-05T12:00:00Z"},
        MintedToken(jwt="", expires_at=datetime(2026, 8, 5, tzinfo=timezone.utc)),
    ],
    ids=["mapping_not_a_model", "empty_jwt"],
)
def test_custom_rejects_malformed_result_with_fetcher_failed(
    result: object,
) -> None:
    async def fetch() -> Any:
        return result

    with pytest.raises(TokenSourceError) as exc:
        asyncio.run(TokenSource.custom(fetch)._get_jwt())
    assert exc.value.code is TokenSourceErrorCode.FETCHER_FAILED


# ── cache and refresh ──────────────────────────────────────────────────────


def _counting_source(expiries_s: list[float]) -> tuple[TokenSource, list[int]]:
    """A custom source whose Nth fetch returns ``jwt-N`` expiring
    ``expiries_s[N-1]`` seconds out (the last entry repeats)."""
    fetches = [0]

    async def fetch() -> MintedToken:
        fetches[0] += 1
        expiry = expiries_s[min(fetches[0], len(expiries_s)) - 1]
        return MintedToken(jwt=f"jwt-{fetches[0]}", expires_at=_expiry_dt(expiry))

    return TokenSource.custom(fetch), fetches


def test_cached_token_is_reused_while_over_the_skew() -> None:
    source, fetches = _counting_source([86_400])

    async def scenario() -> tuple[str, str]:
        return await source._get_jwt(), await source._get_jwt()

    assert asyncio.run(scenario()) == ("jwt-1", "jwt-1")
    assert fetches[0] == 1


def test_token_inside_the_refresh_skew_is_refetched() -> None:
    source, fetches = _counting_source([30, 86_400])

    async def scenario() -> tuple[str, str]:
        return await source._get_jwt(), await source._get_jwt()

    assert asyncio.run(scenario()) == ("jwt-1", "jwt-2")
    assert fetches[0] == 2


def test_invalidate_drops_the_cache_so_the_next_call_refetches() -> None:
    source, fetches = _counting_source([86_400])

    async def scenario() -> tuple[str, str]:
        first = await source._get_jwt()
        source._invalidate()
        return first, await source._get_jwt()

    assert asyncio.run(scenario()) == ("jwt-1", "jwt-2")
    assert fetches[0] == 2


def test_concurrent_callers_share_one_inflight_fetch() -> None:
    started = asyncio.Event()
    release = asyncio.Event()
    fetches = [0]

    async def fetch() -> MintedToken:
        fetches[0] += 1
        started.set()
        await release.wait()
        return MintedToken(jwt=f"jwt-{fetches[0]}", expires_at=_expiry_dt(86_400))

    async def scenario() -> tuple[str, str]:
        source = TokenSource.custom(fetch)
        first = asyncio.create_task(source._get_jwt())
        second = asyncio.create_task(source._get_jwt())
        await started.wait()
        release.set()
        return await first, await second

    assert asyncio.run(scenario()) == ("jwt-1", "jwt-1")
    assert fetches[0] == 1


def test_failed_fetch_is_not_cached_and_the_next_call_retries() -> None:
    fetches = [0]

    async def fetch() -> MintedToken:
        fetches[0] += 1
        if fetches[0] == 1:
            raise TokenSourceError(code=TokenSourceErrorCode.REQUEST_FAILED, message="down")
        return MintedToken(jwt=f"jwt-{fetches[0]}", expires_at=_expiry_dt(86_400))

    async def scenario() -> str:
        source = TokenSource.custom(fetch)
        with pytest.raises(TokenSourceError):
            await source._get_jwt()
        return await source._get_jwt()

    assert asyncio.run(scenario()) == "jwt-2"
    assert fetches[0] == 2


# ── RealtimeClient with a TokenSource credential ────────────────────────────


def _never_fetch() -> TokenSource:
    async def fetch() -> MintedToken:
        raise AssertionError("the token source must not be called")

    return TokenSource.custom(fetch)


def _static_source(jwt: str) -> TokenSource:
    async def fetch() -> MintedToken:
        return MintedToken(jwt=jwt, expires_at=_expiry_dt(86_400))

    return TokenSource.custom(fetch)


def _client(handler: Handler, token: TokenSource) -> RealtimeClient:
    return RealtimeClient(
        token=token,
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )


def test_source_counts_as_the_token_credential_pairing_with_api_key_rejected() -> None:
    with pytest.raises(ValueError):
        RealtimeClient(api_key="sk-secret", token=_never_fetch())


def test_source_client_cannot_mint_and_never_calls_the_source() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("mint_token must fail before reaching the network")

    async def scenario() -> None:
        await _client(handler, _never_fetch()).mint_token("user-123")

    with pytest.raises(MintTokenError) as exc:
        asyncio.run(scenario())
    assert exc.value.code is MintTokenErrorCode.MISSING_API_KEY


def test_auth_headers_carry_the_fetched_jwt() -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["auth"] = request.headers.get("authorization")
        return httpx.Response(
            200,
            json={
                "credential": "user_token",
                "scopes": ["realtime:use"],
                "can_start_sessions": True,
                "realtime_voice_available": True,
                "external_user_id": "user-1",
            },
        )

    async def scenario() -> None:
        info = await _client(handler, _static_source("fetched-jwt")).verify()
        assert info.credential.value == "user_token"

    asyncio.run(scenario())
    assert captured["auth"] == "Bearer fetched-jwt"


def _session_config() -> SessionConfig:
    return SessionConfig(
        sdk=_sdk_info(),        agent=InlineAgentConfig(), session=SessionParams()
    )


@pytest.mark.parametrize(
    ("status", "invalidated"), [(401, True), (403, False)], ids=["401", "403"]
)
def test_session_start_401_invalidates_the_source_cache(
    status: int, invalidated: bool
) -> None:
    source, fetches = _counting_source([86_400])

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            status, json={"error": {"type": "api_error", "message": "nope"}}
        )

    async def scenario() -> None:
        client = _client(handler, source)
        await source._get_jwt()
        assert fetches[0] == 1
        with pytest.raises(SessionStartError):
            await client._post_session_start(_session_config())
        # A refetch after the rejection means the cache was dropped.
        await source._get_jwt()

    asyncio.run(scenario())
    assert fetches[0] == (2 if invalidated else 1)
