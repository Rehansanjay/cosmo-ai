# Python (`cosmo-ai-sdk` on PyPI, import `cosmo_ai`)

Read [core.md](core.md) first. Full API reference:
https://platform.askcosmo.ai/docs. This file is the Python gotchas.

## Current shape

```python
import asyncio
from cosmo_ai import GrokModel, RealtimeClient, SessionEndedEvent, TranscriptDeltaEvent

async def main() -> None:
    # Zero-argument: resolves COSMO_API_KEY, else the `cosmo login`
    # credentials file. Pass api_key=... / token=... to override.
    async with RealtimeClient() as client:
        agent = client.agent(instructions="You are a terse assistant.", model=GrokModel(), voice="ara")
        async with agent.start() as session:
            await session.set_microphone_enabled(True)
            await session.set_speaker_enabled(True)
            async for event in session:
                match event:
                    case TranscriptDeltaEvent():
                        print(event.text)
                    case SessionEndedEvent():
                        print("ended:", event.reason)

asyncio.run(main())
```

## Gotchas

- **Package vs import**: install `cosmo-ai-sdk`, import `cosmo_ai`.
- **`agent.start()` is both awaitable and an async context manager** —
  `async with` ends the session on exit.
- **Tools**: the `@tool` decorator's first parameter is a Pydantic model;
  it drives the model-facing JSON Schema, validation, and the typed
  handler argument. Never hand-write a schema. The docstring becomes the
  tool description.
- **Slow tools**: `@tool(background=True)`. The handler takes exactly two
  parameters, `(input, job: ClientToolJob)`, and returns `None` — `await
  job.ack(note="on it")` releases the reply so the agent keeps talking,
  then `await job.complete(result=..., summary=...)` or `await
  job.fail(error=...)` delivers the outcome whenever the work lands. The
  arity is checked at decoration time, so a one-parameter background
  handler fails immediately.
- **Background voices / the agent answering other speakers**:
  `client.agent(audio=AudioConfig(noise_cancellation=NoiseCancellation.VOICE_FOCUS))`
  (`AudioConfig` and `NoiseCancellation` import from `cosmo_ai`) — off by default; the
  tradeoff and the rest of the `audio` block: [core.md](core.md).
  Distinct from `MicrophoneCapture` on `set_microphone_enabled`, which
  selects the client-side capture processors — those target steady
  noise, not other talkers.
- **Wrong-language transcripts / the agent flipping languages**: there
  is no `language` parameter to set — not on `client.agent(...)`,
  `VoiceConfig`, `AudioConfig`, or a model block; don't invent one. The
  control is `instructions` — the wording and what the platform already
  does: [core.md](core.md).
- **Alpine images fail**: `livekit` publishes no musl wheel — use a
  `python:*-slim` base. On Linux, speaker playback needs PortAudio
  (`apt install libportaudio2`); microphone capture runs in WebRTC's
  audio device module and needs no extra library.
- **Websocket transport**: `RealtimeClient(transport="websocket")` needs
  `cosmo-ai-sdk[websocket]` and reaches a local OSS `cosmo-server`;
  managed Cosmo serves WebRTC only. `COSMO_TRANSPORT` sets the lane when
  the argument is omitted. What the socket refuses: [core.md](core.md).
- The install extras are `[mcp]` (attaching MCP servers) and
  `[websocket]`.

## Build it end to end

The voice-agent-with-a-tool walkthrough:
[../examples/build-a-voice-agent.md](../examples/build-a-voice-agent.md).
