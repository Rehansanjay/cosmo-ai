import Foundation
import Testing
@testable import CosmoRealtime
import CosmoRealtimeAPI

/// Client delegation: the ``delegation-created`` hand-off event and the
/// ``delegation-append`` replies.
@Suite struct DelegationTests {

    private static let createdFrame = Data("""
        {"type":"delegation-created","delegation_id":"dlg-1","transcript":"book me a table"}
        """.utf8)

    @Test("a delegation-created frame surfaces as .delegationCreated")
    func createdFrameDecodes() async throws {
        let transport = FakeSessionTransport()
        let session = RealtimeSession(transport: transport)
        try await session._start(config: SessionConfig(instructions: "hi"))

        let consumer = Task { () -> DelegationCreatedEvent? in
            for try await event in session.events {
                if case .delegationCreated(let payload) = event { return payload }
            }
            return nil
        }
        await session._receiveFrame(Self.createdFrame)
        let payload = try await consumer.value
        await session.end()

        let created = try #require(payload)
        #expect(created.delegationId == "dlg-1")
        #expect(created.transcript == "book me a table")
    }

    @Test("appendCommentary sends a delegation-append frame on the commentary channel")
    func appendCommentaryOnTheWire() async throws {
        let transport = FakeSessionTransport()
        let session = RealtimeSession(transport: transport)
        try await session._start(config: SessionConfig(instructions: "hi"))

        try await session.appendCommentary("Table for two at seven is booked.", delegationId: "dlg-1")
        await session.end()

        let frames = await transport.sent.map(observeSentFrame).filter { $0.type == "delegation-append" }
        let frame = try #require(frames.first)
        #expect(frame.fields["channel"] == .string("commentary"))
        #expect(frame.fields["content"] == .string("Table for two at seven is booked."))
        #expect(frame.fields["delegation_id"] == .string("dlg-1"))
    }

    @Test("appendInstructions without a delegation id omits the field")
    func appendWithoutDelegationId() async throws {
        let transport = FakeSessionTransport()
        let session = RealtimeSession(transport: transport)
        try await session._start(config: SessionConfig(instructions: "hi"))

        try await session.appendInstructions("Keep answers short.")
        await session.end()

        let frames = await transport.sent.map(observeSentFrame).filter { $0.type == "delegation-append" }
        let frame = try #require(frames.first)
        #expect(frame.fields["channel"] == .string("instructions"))
        #expect(frame.fields["delegation_id"] == nil)
    }

    @Test("delegation reaches the openai_live wire block")
    func delegationOnTheWire() throws {
        let config = SessionConfig(
            model: .openaiLive(OpenAILiveModel(delegation: .client)),
            instructions: "hi"
        )
        let payload = try config.wirePayload()
        guard case .inline(let inline)? = payload.agent else {
            Issue.record("expected an inline agent block")
            return
        }
        guard case .openaiLive(let model)? = inline.model?.value2 else {
            Issue.record("expected an openai_live model block")
            return
        }
        #expect(model.delegation == CosmoRealtimeAPI.Components.Schemas.OpenAILiveDelegation.client)
    }
}


/// GPT Live hands off mid-turn without attaching what the user said.
@Suite struct BlankHandoffTranscriptTests {

    private func items(_ turns: [(TranscriptRole, String)]) -> [TranscriptItem] {
        turns.enumerated().map { index, turn in
            TranscriptItem(id: "t\(index)", role: turn.0, text: turn.1, isFinal: true)
        }
    }

    @Test func keepsWhatTheProviderSent() {
        var resolver = DelegationTranscripts()

        #expect(
            resolver.resolve(
                delegationId: "d1",
                wireTranscript: "where is my order",
                items: items([(.user, "hi")])
            ) == "where is my order"
        )
    }

    @Test func standsInTheLastUserTurn() {
        var resolver = DelegationTranscripts()
        let transcript = items([
            (.user, "lets begin"), (.assistant, "Question one…"), (.user, "option B"),
        ])

        #expect(
            resolver.resolve(delegationId: "d1", wireTranscript: "", items: transcript)
                == "option B"
        )
    }

    @Test func oneHandOffResolvesOnce() {
        var resolver = DelegationTranscripts()
        let transcript = items([(.user, "option B")])

        #expect(
            resolver.resolve(delegationId: "d1", wireTranscript: "", items: transcript)
                == "option B"
        )
        #expect(
            resolver.resolve(
                delegationId: "d1",
                wireTranscript: "",
                items: transcript + items([(.user, "lock it")])
            ) == "option B"
        )
    }

    @Test func aTurnNeverStandsInTwice() {
        var resolver = DelegationTranscripts()
        let transcript = items([(.user, "option B")])

        #expect(
            resolver.resolve(delegationId: "d1", wireTranscript: "", items: transcript)
                == "option B"
        )
        #expect(resolver.resolve(delegationId: "d2", wireTranscript: "", items: transcript) == "")
    }

    @Test func neverStandsInATurnTheProviderNamed() {
        var resolver = DelegationTranscripts()
        let transcript = items([(.user, "option B")])

        #expect(
            resolver.resolve(delegationId: "d1", wireTranscript: "option B", items: transcript)
                == "option B"
        )
        #expect(resolver.resolve(delegationId: "d2", wireTranscript: "", items: transcript) == "")
    }

    @Test func nothingToOfferBeforeTheUserSpoke() {
        var resolver = DelegationTranscripts()

        #expect(
            resolver.resolve(
                delegationId: "d1", wireTranscript: "", items: items([(.assistant, "Welcome!")])
            ) == ""
        )
        #expect(resolver.resolve(delegationId: "d2", wireTranscript: "   ", items: []) == "")
    }
}
