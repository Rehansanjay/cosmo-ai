import Foundation

/// A named bundle of contributions to an inline agent.
public struct Plugin: Sendable {
    /// Identity used to reject duplicate plugins and identify conflicts.
    public let name: String
    /// Always-present instructions, appended in plugin order.
    public let instructions: String?
    /// Skills offered through the agent's existing skill loader.
    public let skills: [Skill]
    /// Tools contributed to the agent.
    public let tools: [AgentTool]
    /// Hooks contributed in declaration order.
    public let hooks: [Hook]

    /// Creates a bundle without starting resources or executing callbacks.
    public init(
        name: String,
        instructions: String? = nil,
        skills: [Skill] = [],
        tools: [AgentTool] = [],
        hooks: [Hook] = []
    ) {
        self.name = name
        self.instructions = instructions
        self.skills = skills
        self.tools = tools
        self.hooks = hooks
    }
}

/// The named contribution that conflicts during plugin composition.
public enum PluginErrorCode: String, Sendable, Equatable {
    /// Two plugins have the same name.
    case duplicatePluginName = "duplicate_plugin_name"
    /// Two contributions contain the same skill name.
    case duplicateSkillName = "duplicate_skill_name"
    /// Two contributions contain the same client name or server-tool kind.
    case duplicateToolName = "duplicate_tool_name"
}

/// Plugin composition failed before a session was started.
public struct PluginError: RealtimeError, LocalizedError, Equatable {
    /// Machine-readable reason for the conflict.
    public let code: PluginErrorCode
    /// Explanation identifying the conflicting contributions.
    public let message: String

    /// Creates a plugin composition error.
    public init(code: PluginErrorCode, message: String) {
        self.code = code
        self.message = message
    }

    /// The message for localized error presentation.
    public var errorDescription: String? { message }
}

func resolvePlugins(_ plugins: [Plugin], direct: Plugin) throws -> Plugin {
    var names = Set<String>()
    var skillOwners: [String: String] = [:]
    var toolOwners: [String: String] = [:]
    var instructions: [String] = []
    var skills: [Skill] = []
    var tools: [AgentTool] = []
    var hooks: [Hook] = []
    func claim(_ owners: inout [String: String], name: String, owner: String, code: PluginErrorCode) throws {
        if let previous = owners[name] {
            throw PluginError(code: code, message: "\(name): conflict between \(previous) and \(owner)")
        }
        owners[name] = owner
    }
    for plugin in plugins {
        guard names.insert(plugin.name).inserted else {
            throw PluginError(code: .duplicatePluginName, message: "duplicate plugin name: \(plugin.name)")
        }
    }
    for (bundle, owner) in plugins.map({ ($0, "plugin '\($0.name)'") }) + [(direct, "agent")] {
        if let text = bundle.instructions, !text.isEmpty { instructions.append(text) }
        for skill in bundle.skills {
            try claim(&skillOwners, name: skill.name, owner: owner, code: .duplicateSkillName)
            skills.append(skill)
        }
        for tool in bundle.tools {
            try claim(&toolOwners, name: tool.payload.pluginKey, owner: owner, code: .duplicateToolName)
            tools.append(tool)
        }
        hooks.append(contentsOf: bundle.hooks)
    }
    return Plugin(
        name: direct.name,
        instructions: instructions.isEmpty ? direct.instructions : instructions.joined(separator: "\n\n"),
        skills: skills, tools: tools, hooks: hooks
    )
}

private extension AgentToolPayload {
    var pluginKey: String {
        switch self {
        case .client, .backgroundClient, .sdkClient: return "client:\(name)"
        case .webSearch: return "server:web_search"
        case .examineImage: return "server:examine_image"
        case .detectObjects: return "server:detect_objects"
        case .pointAtObject: return "server:point_at_object"
        case .speakerLog: return "server:speaker_log"
        case .endCall: return "server:end_call"
        case .screenLocate: return "server:screen_locate"
        }
    }
}
