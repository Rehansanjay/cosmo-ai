import { agentToolPayload, type AgentConfig, type AgentTool } from './agent';
import type { Hook, ServerHook } from './hooks';
import { resolveSkills, type Skill } from './skills';
import { RealtimeError } from './errors';

/** A named bundle of contributions to an inline agent. */
export type Plugin = {
  /** Identity used to reject duplicate plugins and identify conflicts. */
  readonly name: string;
  /** Always-present instructions, appended in plugin order. */
  readonly instructions?: string;
  /** Skills offered through the agent's existing skill loader. */
  readonly skills?: readonly Skill[];
  /** Tools contributed to the agent. */
  readonly tools?: readonly AgentTool[];
  /** Hooks contributed in declaration order. */
  readonly hooks?: readonly (Hook | ServerHook)[];
};

/** The named contribution that conflicts during plugin composition. */
export type PluginErrorCode =
  | 'duplicate_plugin_name'
  | 'duplicate_skill_name'
  | 'duplicate_tool_name';

/** Plugin composition failed before a session was started. */
export class PluginError extends RealtimeError {
  /** Machine-readable reason for the conflict. */
  readonly code: PluginErrorCode;

  /** Create a plugin composition error. */
  constructor(options: { code: PluginErrorCode; message: string }) {
    super(options.message);
    this.name = 'PluginError';
    this.code = options.code;
  }
}

/** Expand bundles into ordinary agent configuration. @internal */
export function resolvePlugins(config: AgentConfig): AgentConfig {
  const { plugins, ...direct } = config;
  if (!plugins?.length) return direct;
  resolveSkills(direct.skills);
  const names = new Set<string>();
  const skillOwners = new Map<string, string>();
  const toolOwners = new Map<string, string>();
  const instructions: string[] = [];
  const skills: Skill[] = [];
  const tools: AgentTool[] = [];
  const hooks: (Hook | ServerHook)[] = [];
  const claim = (
    owners: Map<string, string>, name: string, owner: string, code: PluginErrorCode,
  ): void => {
    const previous = owners.get(name);
    if (previous !== undefined) {
      throw new PluginError({
        code, message: `${name}: conflict between ${previous} and ${owner}`,
      });
    }
    owners.set(name, owner);
  };
  const append = (bundle: Omit<Plugin, 'name'>, owner: string): void => {
    if (bundle.instructions) instructions.push(bundle.instructions);
    for (const skill of bundle.skills ?? []) {
      claim(skillOwners, skill.name, owner, 'duplicate_skill_name');
      skills.push(Object.freeze({ ...skill }));
    }
    for (const tool of bundle.tools ?? []) {
      const payload = agentToolPayload(tool);
      const key = payload.kind === 'client' ? `client:${payload.name}` : `server:${payload.kind}`;
      claim(toolOwners, key, owner, 'duplicate_tool_name');
      tools.push(tool);
    }
    hooks.push(...(bundle.hooks ?? []));
  };
  for (const plugin of plugins) {
    if (names.has(plugin.name)) {
      throw new PluginError({
        code: 'duplicate_plugin_name', message: `duplicate plugin name: ${plugin.name}`,
      });
    }
    names.add(plugin.name);
  }
  for (const plugin of plugins) append(plugin, `plugin '${plugin.name}'`);
  append(direct, 'agent');
  return {
    ...direct,
    instructions: instructions.length ? instructions.join('\n\n') : direct.instructions,
    skills,
    tools,
    hooks,
  };
}
