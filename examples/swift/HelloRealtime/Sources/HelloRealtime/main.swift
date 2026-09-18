import CosmoRealtime
import Foundation

struct WeatherArgs: Decodable, Sendable {
    let city: String
    let unit: Unit?
    enum Unit: String, Decodable, Sendable { case c, f }
}

enum ExampleConfigurationError: LocalizedError {
    case invalidTransport(String)

    var errorDescription: String? {
        switch self {
        case .invalidTransport(let value):
            return "COSMO_TRANSPORT must be livekit or websocket, not \(value)"
        }
    }
}

func resolveTransport(
    environment: [String: String]
) throws -> RealtimeClient.Transport {
    let value = environment["COSMO_TRANSPORT"]?.lowercased() ?? "livekit"
    guard let transport = RealtimeClient.Transport(rawValue: value) else {
        throw ExampleConfigurationError.invalidTransport(value)
    }
    return transport
}

let getWeather = try AgentTool.clientTool(
    name: "get_weather",
    description: "Current weather for a city",
    input: .object(
        properties: [
            "city": .string(description: "City name"),
            "unit": .enum(["c", "f"]),
        ],
        required: ["city"]
    )
) { (args: WeatherArgs) in
    let unit = args.unit ?? .c
    print("[tool] get_weather city=\(args.city) unit=\(unit.rawValue)")
    return ["temp": .double(unit == .c ? 21.5 : 70.7), "unit": .string(unit.rawValue)]
}

// A client holds the credential, endpoint and transport; an agent is the
// persona configured on top of it. The external protocol scopes the project
// from the API key server-side, so there is no project_id to pass here.
let transport = try resolveTransport(environment: ProcessInfo.processInfo.environment)
print("Connecting via \(transport.rawValue)…")
let client = try RealtimeClient(transport: transport)
let agent = try client.agent(tools: [getWeather])
let session = try await agent.start()

// Consumption is a single typed event stream. Drain it on a task; `.sessionEnded`
// is the final element and finishes the stream. No listeners to register up
// front — the stream buffers from session start, so nothing is missed.
let events = Task {
    do {
        for try await event in session.events {
            switch event {
            case .ready(let ready):
                print("Session ready — id: \(ready.sessionId)")
                print("Speak into your microphone. Press Enter to end.")
            case .transcript(let delta):
                let role = delta.role == .user ? "user" : "assistant"
                let marker = delta.isFinal ? " »" : "…"
                print("[\(role)]\(marker) \(delta.text)")
            case .error(let err):
                fputs("Server error (\(err.code.rawValue)): \(err.message)\n", stderr)
            case .sessionEnded(let ended):
                print("Session ended: \(ended.reason ?? "")")
            default:
                break
            }
        }
    } catch {
        fputs("event stream error: \(error)\n", stderr)
    }
}

print("Microphone live.")

// Block until the user presses Enter, then tear down gracefully.
_ = readLine()

print("Ending…")
await session.end()
events.cancel()

print("Done.")
