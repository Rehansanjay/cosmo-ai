import Foundation

/// What a hand-off was about, when the provider did not say.
///
/// GPT Live raises a hand-off mid-turn and does not always attach the user's
/// words: measured on a live session, 3 of 15 carried an empty transcript. An
/// application whose backend is handed only that string has nothing to act on,
/// so the session's own transcript stands in — the last user turn is the one
/// the hand-off is about.
///
/// Two rules keep the substitution honest. A hand-off resolves once, so every
/// surface sees the same text for it. And a user turn stands in for at most
/// one hand-off, so two blank hand-offs in a row never replay the same
/// instruction.
struct DelegationTranscripts {
    private var resolved: [String: String] = [:]
    private var spent: Set<String> = []

    mutating func resolve(
        delegationId: String,
        wireTranscript: String,
        items: [TranscriptItem]
    ) -> String {
        if let already = resolved[delegationId] { return already }
        // Every hand-off spends the turn it was about, whether the provider
        // named it or this did: otherwise a blank hand-off following one the
        // provider filled would stand the same turn in again and act on it
        // twice.
        let latest = latestUserTurn(items)
        let fresh = latest.map { !spent.contains($0.id) } ?? false
        if let latest { spent.insert(latest.id) }
        let transcript: String
        if wireTranscript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            transcript = fresh ? (latest?.text ?? "") : ""
        } else {
            transcript = wireTranscript
        }
        resolved[delegationId] = transcript
        return transcript
    }

    private func latestUserTurn(_ items: [TranscriptItem]) -> TranscriptItem? {
        items.last {
            $0.role == .user
                && !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }
}
