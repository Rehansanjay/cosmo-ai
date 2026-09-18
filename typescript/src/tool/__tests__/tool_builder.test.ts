/** The ``clientTool()`` builder: construction-time checks, the two input
 *  forms, the normalized ``INVALID_INPUT`` error contract, lowering to the
 *  hand-written spec shape, and the dispatch-layer integration (envelope +
 *  hook-rewrite attribution). Python mirror: ``tests/test_tool_decorator.py``. */

import { describe, expect, it, vi } from 'vitest';
import { agentToolPayload, buildAgentSessionConfig } from '../../core/agent';
import * as z from 'zod/v4';

import type { RpcInvocation } from '../../transport/types';
import type { AgentTool, BackgroundClientTool, ClientTool } from '../../core/agent';

import { registerClientToolHandlers } from '../../core/client_tools';
import { HookEngine, preToolUse } from '../../core/hooks';
import {
  RealtimeError,
  ToolInputValidationError,
  ToolDefinitionError,
  type ToolDefinitionErrorCode,
  backgroundClientTool,
  clientTool,
} from '../index';
import { zodInput } from '../zod';

/** ``clientTool()`` returns the opaque public type, so the builder tests
 *  narrow through the internal payload to read the declared shape they
 *  assert on. */
const declared = (t: AgentTool): ClientTool | BackgroundClientTool =>
  agentToolPayload(t) as ClientTool | BackgroundClientTool;

/** The two handler shapes differ in arity, so invoking one needs the branch. */
const clientHandler = (t: AgentTool): ClientTool['handler'] =>
  (agentToolPayload(t) as ClientTool).handler;
const backgroundHandler = (t: AgentTool): BackgroundClientTool['handler'] =>
  (agentToolPayload(t) as BackgroundClientTool).handler;


const SESSION = 'sess-1';

function makeRegistrar() {
  const methods = new Map<string, (invocation: RpcInvocation) => Promise<string>>();
  return {
    registerRpcMethod(
      name: string,
      handler: (invocation: RpcInvocation) => Promise<string>,
    ): () => void {
      methods.set(name, handler);
      return () => {
        methods.delete(name);
      };
    },
    invoke(name: string, payload: string): Promise<string> {
      const handler = methods.get(name);
      if (handler === undefined) throw new Error(`no rpc method ${name}`);
      return handler({
        payload,
        callerIdentity: 'agent:sess-1',
        callerIsAgent: true,
      });
    },
  };
}

function registerOne(spec: AgentTool, opts: { hooks?: HookEngine } = {}) {
  const registrar = makeRegistrar();
  registerClientToolHandlers(registrar, [agentToolPayload(spec)], {
    hooks: opts.hooks ?? null,
    sessionId: SESSION,
  });
  return registrar;
}

const weatherInput = () =>
  zodInput(
    z.object({
      city: z.string(),
      unit: z.enum(['c', 'f']).default('c'),
    }),
  );

describe('construction-time checks', () => {
  /** A message regex passes on a plain `Error` too, so every case below also
   *  asserts the type and the code — that is what pins the declaration paths
   *  to the error family. */
  function expectDefinitionError(fn: () => unknown, code: ToolDefinitionErrorCode): void {
    let thrown: unknown;
    try {
      fn();
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ToolDefinitionError);
    expect(thrown).toBeInstanceOf(RealtimeError);
    expect((thrown as ToolDefinitionError).code).toBe(code);
  }

  it('rejects a name outside the tool-name grammar', () => {
    const build = () =>
      clientTool({ name: 'Bad-Name', description: 'x', parameters: { type: 'object' }, handler: async () => ({}) });
    expect(build).toThrow(/must match/);
    expectDefinitionError(build, 'invalid_tool_name');
  });

  it('requires a description', () => {
    const build = () =>
      clientTool({ name: 'get_weather', description: '', parameters: { type: 'object' }, handler: async () => ({}) });
    expect(build).toThrow(/has no description/);
    expectDefinitionError(build, 'missing_description');
  });

  it('reports actual and max length for an overlong description', () => {
    const build = () =>
      clientTool({
        name: 'get_weather',
        description: 'x'.repeat(2049),
        parameters: { type: 'object' },
        handler: async () => ({}),
      });
    expect(build).toThrow(/2049 characters; the protocol limit is 2048/);
    expectDefinitionError(build, 'description_too_long');
  });

  it('routes a reserved SDK-prefixed name through ToolDefinitionError', () => {
    // The guard lives in buildAgentSessionConfig, so it fires at start rather
    // than at construction — it threw a plain Error, outside the family.
    const squatter = clientTool({
      name: 'get_weather',
      description: 'x',
      parameters: { type: 'object' },
      handler: async () => ({}),
    });
    const build = () =>
      buildAgentSessionConfig(
        { tools: [{ ...squatter, name: 'cosmo_sdk_draw_box' }] } as never,
        {},
      );
    expect(build).toThrow(ToolDefinitionError);
    expectDefinitionError(build, 'invalid_tool_name');
  });

  it('rejects a description with a control character', () => {
    expect(() =>
      clientTool({
        name: 'get_weather',
        description: 'badtext',
        parameters: { type: 'object' },
        handler: async () => ({}),
      }),
    ).toThrow(/control character/);
  });

  it('dialect-checks raw parameters', () => {
    expect(() =>
      clientTool({
        name: 'get_weather',
        description: 'Weather',
        parameters: {
          type: 'object',
          properties: { sku: { type: 'string', pattern: '^[A-Z]+$' } },
        },
        handler: async () => ({}),
      }),
    ).toThrow(ToolDefinitionError);
  });
});

describe('lowering', () => {
  it('emits the hand-written spec shape', () => {
    const spec = clientTool({
      name: 'get_weather',
      description: 'Current weather for a city',
      input: weatherInput(),
      handler: async () => null,
    });
    expect(declared(spec).kind).toBe('client');
    expect(declared(spec).background).toBeUndefined();
    expect(declared(spec).name).toBe('get_weather');
    expect(declared(spec).description).toBe('Current weather for a city');
    expect(declared(spec).parameters).toEqual({
      type: 'object',
      properties: {
        city: { type: 'string' },
        unit: { type: 'string', enum: ['c', 'f'], default: 'c' },
      },
      required: ['city'],
    });
    expect(typeof declared(spec).handler).toBe('function');
  });

  it('background form lowers to a BackgroundClientTool', () => {
    const spec = backgroundClientTool({
      name: 'export_report',
      description: 'Export a report',
      input: weatherInput(),
      handler: async (_args, job) => {
        await job.ack('started');
      },
    });
    expect(declared(spec).kind).toBe('client');
    expect(declared(spec).background).toBe(true);
  });

  it('raw form passes parameters through verbatim', () => {
    const parameters = {
      type: 'object',
      properties: { city: { type: 'string' } },
    };
    const spec = clientTool({
      name: 'get_weather',
      description: 'Weather',
      parameters,
      handler: async () => ({}),
    });
    expect(declared(spec).parameters).toBe(parameters);
    // A client tool carries the handler that runs it. The raw form still
    // wraps the authored one — validation is a passthrough here — so what
    // lowers is a function, not the absence of one.
    expect(typeof declared(spec).handler).toBe('function');
  });
});

describe('typed validation', () => {
  it('passes validated, default-filled args to the handler', async () => {
    const seen: unknown[] = [];
    const spec = clientTool({
      name: 'get_weather',
      description: 'Weather',
      input: weatherInput(),
      handler: async (args) => {
        seen.push(args);
        return { ok: true };
      },
    });
    const result = await clientHandler(spec)?.({ city: 'Oslo' });
    expect(result).toEqual({ ok: true });
    expect(seen).toEqual([{ city: 'Oslo', unit: 'c' }]);
  });

  it('the handler receives the validator output for a transforming schema', async () => {
    const input = zodInput(
      z.object({ city: z.string().transform((value) => value.length) }),
    );
    const seen: unknown[] = [];
    const spec = clientTool({
      name: 'get_weather',
      description: 'Weather',
      input,
      handler: async (args) => {
        seen.push(args.city);
        return null;
      },
    });
    expect(input.parameters).toEqual({
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    });
    await clientHandler(spec)?.({ city: 'Oslo' });
    expect(seen).toEqual([4]);
  });

  it('does not start authored code when cancellation lands during async validation', async () => {
    let finishValidation!: () => void;
    let validationStarted!: () => void;
    const started = new Promise<void>((resolve) => { validationStarted = resolve; });
    const input = zodInput(z.object({
      city: z.string().refine(async () => {
        validationStarted();
        await new Promise<void>((resolve) => { finishValidation = resolve; });
        return true;
      }),
    }));
    const authored = vi.fn(async () => null);
    const spec = clientTool({
      name: 'get_weather',
      description: 'Weather',
      input,
      handler: authored,
    });
    const controller = new AbortController();
    const running = clientHandler(spec)?.({ city: 'Oslo' }, controller.signal);
    await started;

    controller.abort();
    finishValidation();

    await expect(running).rejects.toBe(controller.signal.reason);
    expect(authored).not.toHaveBeenCalled();
  });

  it('throws the normalized INVALID_INPUT shape without submitted values', async () => {
    const spec = clientTool({
      name: 'get_weather',
      description: 'Weather',
      input: weatherInput(),
      handler: async () => null,
    });
    const secret = 'hunter2-credential';
    let thrown: unknown = null;
    try {
      await clientHandler(spec)?.({ unit: secret });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ToolInputValidationError);
    const error = thrown as ToolInputValidationError;
    expect(error.message).toBe(
      'INVALID_INPUT: get_weather rejected parameters:\n' +
        '- city: required\n' +
        '- unit: expected one of "c", "f"\n' +
        'Fix the input and retry.',
    );
    expect(error.message).not.toContain(secret);
    expect(JSON.stringify(error.issues)).not.toContain(secret);
  });

  it('caps issue lines at five and appends the hidden count', async () => {
    const input = zodInput(
      z.object({
        a: z.string(),
        b: z.string(),
        c: z.string(),
        d: z.string(),
        e: z.string(),
        f: z.string(),
        g: z.string(),
      }),
    );
    const spec = clientTool({
      name: 'many_fields',
      description: 'Many fields',
      input,
      handler: async () => null,
    });
    let thrown: unknown = null;
    try {
      await clientHandler(spec)?.({});
    } catch (err) {
      thrown = err;
    }
    const message = (thrown as ToolInputValidationError).message;
    expect(message.split('\n').filter((line) => line.startsWith('- '))).toHaveLength(6);
    expect(message).toContain('- … and 2 more');
  });

  it('nested paths render dotted with array indices', async () => {
    const input = zodInput(
      z.object({
        items: z.array(z.object({ sku: z.string() })),
      }),
    );
    const spec = clientTool({
      name: 'submit_order',
      description: 'Submit an order',
      input,
      handler: async () => null,
    });
    let thrown: unknown = null;
    try {
      await clientHandler(spec)?.({ items: [{ sku: 'ok' }, {}] });
    } catch (err) {
      thrown = err;
    }
    expect((thrown as ToolInputValidationError).message).toContain('- items[1].sku: required');
  });

  it('fails closed on a non-object handler return', async () => {
    const spec = clientTool({
      name: 'get_weather',
      description: 'Weather',
      input: weatherInput(),
      handler: async () => 'nope' as unknown as null,
    });
    await expect(clientHandler(spec)?.({ city: 'Oslo' })).rejects.toThrow(
      /result must be an object/,
    );
  });

  it('background typed handler validates before user code', async () => {
    const spec = backgroundClientTool({
      name: 'export_report',
      description: 'Export a report',
      input: weatherInput(),
      handler: async () => {
        throw new Error('user code must not run');
      },
    });
    const job = { ack: async () => undefined } as never;
    await expect(backgroundHandler(spec)?.({}, job)).rejects.toThrow(/INVALID_INPUT/);
  });
});

describe('dispatch integration', () => {
  it('a malformed model call becomes the {ok: false} envelope', async () => {
    const spec = clientTool({
      name: 'get_weather',
      description: 'Weather',
      input: weatherInput(),
      handler: async () => ({ tempC: 7 }),
    });
    const registrar = registerOne(spec);
    const reply = JSON.parse(await registrar.invoke('get_weather', '{"unit":"x"}'));
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain('INVALID_INPUT: get_weather rejected parameters:');
    expect(reply.error).not.toContain('"x"');
  });

  it('a hook rewrite that breaks validation logs the attribution event', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const spec = clientTool({
        name: 'get_weather',
        description: 'Weather',
        input: weatherInput(),
        handler: async () => null,
      });
      const hooks = new HookEngine([
        preToolUse(() => ({ updatedArguments: { city: 42 } })),
      ]);
      const registrar = registerOne(spec, { hooks });
      const reply = JSON.parse(
        await registrar.invoke('get_weather', '{"city":"Oslo"}'),
      );
      expect(reply.ok).toBe(false);
      expect(warn).toHaveBeenCalledWith(
        '[realtime] client tool validation failed after hook rewrite',
        { tool: 'get_weather' },
      );
    } finally {
      warn.mockRestore();
      errorLog.mockRestore();
    }
  });

  it('an equal-but-reordered hook rewrite does not log the attribution event', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const spec = clientTool({
        name: 'get_weather',
        description: 'Weather',
        input: weatherInput(),
        handler: async () => null,
      });
      const hooks = new HookEngine([
        preToolUse(() => ({ updatedArguments: { unit: 'x', city: 'Oslo' } })),
      ]);
      const registrar = registerOne(spec, { hooks });
      const reply = JSON.parse(
        await registrar.invoke('get_weather', '{"city":"Oslo","unit":"x"}'),
      );
      expect(reply.ok).toBe(false);
      expect(warn).not.toHaveBeenCalledWith(
        '[realtime] client tool validation failed after hook rewrite',
        expect.anything(),
      );
    } finally {
      warn.mockRestore();
      errorLog.mockRestore();
    }
  });

  it('a model-caused validation failure does not log the attribution event', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const spec = clientTool({
        name: 'get_weather',
        description: 'Weather',
        input: weatherInput(),
        handler: async () => null,
      });
      const registrar = registerOne(spec, { hooks: new HookEngine([]) });
      await registrar.invoke('get_weather', '{"unit":"x"}');
      expect(warn).not.toHaveBeenCalledWith(
        '[realtime] client tool validation failed after hook rewrite',
        expect.anything(),
      );
    } finally {
      warn.mockRestore();
      errorLog.mockRestore();
    }
  });
});
