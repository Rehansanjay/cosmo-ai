/**
 * First-class client-tool builder: ``clientTool({ input, handler })``.
 *
 * One runtime schema drives the model-facing JSON Schema, runtime
 * validation, and the handler's argument types::
 *
 *     import { clientTool } from 'cosmo-ai/tool';
 *     import { zodInput } from 'cosmo-ai/tool/zod';
 *
 *     const getWeather = clientTool({
 *       name: 'get_weather',
 *       description: 'Current weather for a city',
 *       input: zodInput(z.object({ city: z.string(), unit: z.enum(['c', 'f']) })),
 *       handler: async ({ city, unit }) => ({ tempC: await lookup(city) }),
 *     });
 *
 * The builder lowers to the existing spec types ({@link ClientTool} /
 * {@link BackgroundClientTool}); hand-written raw ``parameters`` remain
 * the advanced escape hatch. The emitted schema is checked against the
 * backend's restricted dialect when the tool is constructed, so a schema
 * the server would reject fails at startup instead of surfacing as a
 * ``ready.rejectedTools`` entry at connect.
 *
 * Two input forms, the same two Python and Swift take:
 *
 * 1. ``{ input: ToolInput }`` — the typed path. Only converter entry points
 *    (``zodInput`` from ``cosmo-ai/tool/zod``) mint a ``ToolInput``, so
 *    "input must be convertible" is a compile-time fact.
 * 2. ``{ parameters }`` — the raw escape hatch: hand-written dialect JSON
 *    Schema, handler args typed ``Record<string, unknown>``, no validation.
 *    A validator the SDK ships no converter for goes here — call it inside
 *    the handler.
 *
 * A malformed model call throws {@link ToolInputValidationError} inside the
 * synthesized handler before user code runs; the dispatch layer turns it
 * into the ``{ok: false, error}`` envelope so the model can self-correct.
 * PreToolUse hooks still see (and may rewrite) raw args — validation applies
 * to the post-hook args.
 *
 * Validation semantics are the runtime schema library's own. The emitted
 * schema describes the **accepted input**; the handler receives the
 * **validator's output** (transforms are legal).
 */

import { mintAgentTool } from '../core/agent';
import type {
  AgentTool,
  BackgroundClientTool,
  ClientTool,
} from '../core/agent';
import type { ClientToolJob } from '../core/client_tool_jobs';

import {
  ToolDefinitionError,
  ToolInputValidationError,
  formatInvalidInput,
  type ToolInputIssue,
} from './errors';
import {
  type ToolInput,
} from './input';
import { buildToolParameters, checkSchemaDialect, textViolation } from './schema';

export { RealtimeError } from '../core/errors';
export {
  ToolInputValidationError,
  ToolDefinitionError,
  type ToolDefinitionErrorCode,
  type ToolInputIssue,
} from './errors';

const NAME_RE = /^[a-z][a-z0-9_]{2,63}$/;
const MAX_DESCRIPTION_LEN = 2048;

/** The reply envelope's ``result`` slot is ``object | null`` across the
 *  cross-SDK contract, so handler results stay object-shaped. */
type ToolResult = Record<string, unknown> | null | undefined | void;

/** What the constructors accept, widened — the shape `buildClientTool` and
 *  `resolveInput` work against once an overload has been chosen. The public
 *  signatures below state their own fields rather than naming a type: each
 *  is one call shape, so a named type for it would only shorten the
 *  signature, and a reader would have to look it up to know what to pass. */
/** The typed form: a schema minted by a converter (`zodInput`), and a
 *  handler that receives the validated, default-filled arguments. The
 *  handler is a parameter because it is the only thing that differs between
 *  the immediate and background constructors — `parameters` is present and
 *  `undefined` so that passing both forms is a type error, not a silent
 *  preference for the raw one. */
export type ClientToolOptions<T, Handler> = {
  /** Wire name the model calls. Must match ``^[a-z][a-z0-9_]{2,63}$``. */
  name: string;
  /** Model-facing description of when and how to call the tool. */
  description: string;
  /** The argument schema, as a Zod schema or a ``toolSchema`` builder. It
   *  both declares the parameters to the model and validates what comes
   *  back, so the handler receives a typed value. */
  input: ToolInput<T>;
  /** Never set on this form — present so that supplying both ``input`` and
   *  ``parameters`` is a type error rather than a silent preference. */
  parameters?: undefined;
  /** Runs the tool. Receives the validated arguments; what it returns goes
   *  back to the model. */
  handler: Handler;
};

/** The raw form: a hand-written dialect schema, and a handler that receives
 *  the model's arguments verbatim — nothing validates them. */
export type RawClientToolOptions<Handler> = {
  /** Wire name the model calls. Must match ``^[a-z][a-z0-9_]{2,63}$``. */
  name: string;
  /** Model-facing description of when and how to call the tool. */
  description: string;
  /** Never set on this form — present so that supplying both ``input`` and
   *  ``parameters`` is a type error rather than a silent preference. */
  input?: undefined;
  /** A hand-written JSON Schema object in the restricted dialect the
   *  backend accepts. Declared to the model but not validated, so the
   *  handler sees the model's arguments verbatim. */
  parameters: Record<string, unknown>;
  /** Runs the tool. Receives the model's arguments unvalidated; what it
   *  returns goes back to the model. */
  handler: Handler;
};

/** What the implementations work against once an overload has been chosen. */
type ToolOptions = {
  name: string;
  description: string;
  input?: unknown;
  parameters?: Record<string, unknown>;
  handler: unknown;
};

/** Declare a client tool from a validated ``input`` schema: the SDK
 *  advertises it at session start and the server routes matching invocations
 *  back over the transport. The handler receives arguments already parsed to
 *  ``T``. Python spells this ``client_tool`` (with ``@tool`` as its decorator
 *  form) and Swift ``AgentTool.clientTool``. */
export function clientTool<T, R extends ToolResult>(
  options: ClientToolOptions<T, (args: T, signal?: AbortSignal) => Promise<R>>,
): AgentTool;
/** Declare a client tool from a hand-written ``parameters`` JSON Schema.
 *  The escape hatch from the ``input`` form above: nothing validates the
 *  arguments, so the handler receives them raw. */
export function clientTool<R extends ToolResult>(
  options: RawClientToolOptions<
    (args: Record<string, unknown>, signal?: AbortSignal) => Promise<R>
  >,
): AgentTool;
export function clientTool(options: ToolOptions): AgentTool {
  return buildClientTool(options, false);
}

/** Declare a client tool whose work outlives the voice turn, from a
 *  validated ``input`` schema: the handler acks the call through the
 *  ``ClientToolJob`` and delivers the result later. The background form is a
 *  separate constructor rather than a flag, matching
 *  ``background_client_tool`` in Python and Swift. */
export function backgroundClientTool<T>(
  options: ClientToolOptions<T, (args: T, job: ClientToolJob) => Promise<void>>,
): AgentTool;
/** Declare a background client tool from a hand-written ``parameters`` JSON
 *  Schema. The escape hatch from the ``input`` form above: nothing validates
 *  the arguments, so the handler receives them raw. */
export function backgroundClientTool(
  options: RawClientToolOptions<
    (args: Record<string, unknown>, job: ClientToolJob) => Promise<void>
  >,
): AgentTool;
export function backgroundClientTool(options: ToolOptions): AgentTool {
  return buildClientTool(options, true);
}

function buildClientTool(
  options: ToolOptions,
  background: boolean,
): AgentTool {
  checkName(options.name);
  checkDescription(options.name, options.description);
  const { parameters, validate } = resolveInput(options);

  // The constructor picked the form, so `options` is not narrowed by a flag:
  // each branch states which handler arity it is about to call.
  if (background) {
    const authored = options.handler as (
      args: unknown,
      job: ClientToolJob,
    ) => Promise<void>;
    const handler = async (
      args: Record<string, unknown>,
      job: ClientToolJob,
    ): Promise<void> => {
      await authored((await validate(args)) as Record<string, unknown>, job);
    };
    return mintAgentTool({
      kind: 'client',
      background: true,
      name: options.name,
      description: options.description,
      parameters,
      handler,
    });
  }

  const authored = options.handler as (
    args: unknown,
    signal?: AbortSignal,
  ) => Promise<ToolResult>;
  const handler = async (
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown> | null | undefined | void> => {
    const validated = (await validate(args)) as Record<string, unknown>;
    signal?.throwIfAborted();
    const result = await authored(validated, signal);
    return checkedResult(result, options.name);
  };
  return mintAgentTool({
    kind: 'client',
    name: options.name,
    description: options.description,
    parameters,
    handler,
  });
}

type ResolvedInput = {
  parameters: Record<string, unknown>;
  /** Identity for the raw form; throws {@link ToolInputValidationError} on
   *  a malformed model call otherwise. */
  validate: (args: Record<string, unknown>) => Promise<never> | Promise<unknown>;
};

function isToolInput(value: unknown): value is ToolInput<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ToolInput<unknown>).validate === 'function' &&
    typeof (value as ToolInput<unknown>).parameters === 'object'
  );
}

function resolveInput(
  options: ToolOptions,
): ResolvedInput {
  if (options.parameters !== undefined) {
    checkSchemaDialect(options.parameters, options.name);
    return { parameters: options.parameters, validate: async (args) => args };
  }
  const input = options.input;
  if (!isToolInput(input)) {
    throw new TypeError(
      `tool '${options.name}': input must be a ToolInput minted by a converter ` +
        `entry point (e.g. zodInput from 'cosmo-ai/tool/zod'). For a ` +
        `validator with no converter, pass its schema as parameters and ` +
        `call the validator inside the handler`,
    );
  }
  return {
    parameters: input.parameters,
    validate: async (args) => {
      const parsed = await input.validate(args);
      if (!parsed.ok) {
        throw new ToolInputValidationError(
          formatInvalidInput(options.name, parsed.issues),
          { issues: parsed.issues },
        );
      }
      return parsed.value;
    },
  };
}

/** Validate through a bare Standard Schema. Issue lines carry the failing
 *  path only — a foreign vendor's ``message`` may embed submitted values. */

function checkName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new ToolDefinitionError({
      code: 'invalid_tool_name',
      message: `tool name '${name}' must match ${NAME_RE.source}`,
    });
  }
}

function checkDescription(name: string, description: string): void {
  if (description === '') {
    throw new ToolDefinitionError({
      code: 'missing_description',
      message:
        `tool '${name}' has no description — the description is model-facing ` +
        `and required`,
    });
  }
  if (description.length > MAX_DESCRIPTION_LEN) {
    throw new ToolDefinitionError({
      code: 'description_too_long',
      message:
        `tool '${name}' description is ${description.length} characters; the ` +
        `protocol limit is ${MAX_DESCRIPTION_LEN}`,
    });
  }
  const reason = textViolation(description, { allowNewlines: true });
  if (reason !== null) {
    throw new ToolDefinitionError({
      code: 'invalid_text',
      message: `tool '${name}' description ${reason}`,
    });
  }
}

/** Fail closed on a handler return the wire cannot carry: the reply
 *  envelope's ``result`` slot is ``object | null``, so a non-object return
 *  is a handler bug surfaced as a tool error. */
function checkedResult(
  result: unknown,
  toolName: string,
): Record<string, unknown> | null | undefined {
  if (
    result === null ||
    result === undefined ||
    (typeof result === 'object' && !Array.isArray(result))
  ) {
    return result as Record<string, unknown> | null | undefined;
  }
  throw new TypeError(
    `tool handler '${toolName}' returned ${typeof result}; a client tool ` +
      `result must be an object (serialized as the JSON object the model ` +
      `receives), null, or undefined`,
  );
}
