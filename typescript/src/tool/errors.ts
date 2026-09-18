/**
 * Typed errors for the tool builder, plus the normalized ``INVALID_INPUT``
 * message shape shared across the SDKs.
 */

import { RealtimeError } from '../core/errors';

/** One sanitized validation issue: structured path + constraint text built
 *  from schema-derived fields only — the submitted values never appear. */
export type ToolInputIssue = {
  /** Dotted path to the offending field (`address.city`, `items[2].sku`), or
   *  `(root)` when the whole argument object was rejected. */
  path: string;
  /** The validator's stable issue code (e.g. `'invalid_type'`). */
  code: string;
  /** The violated constraint (`'required'`, `'expected a string'`, …). */
  constraint: string;
};

/** Render validator path segments as the dotted form `ToolInputIssue.path`
 *  carries. Numbers are array indices. */
export function issuePath(path: readonly (string | number)[]): string {
  const parts: string[] = [];
  for (const item of path) {
    if (typeof item === 'number') parts.push(`[${item}]`);
    else if (parts.length > 0) parts.push(`.${item}`);
    else parts.push(String(item));
  }
  return parts.join('') || '(root)';
}

/** What is wrong with a tool declaration.
 *
 *  Closed: every one is thrown when a tool is constructed, so it changes only
 *  when the SDK does. Every member is declared in every SDK even where that
 *  SDK cannot reach the case, so a branch written against one ports
 *  unchanged. */
export type ToolDefinitionErrorCode =
  /** `additionalProperties` is set to a value the dialect refuses. */
  | 'additional_properties_forbidden'
  /** The schema uses a keyword the dialect does not accept — `$ref`, `format`, `oneOf`, `pattern` and friends. */
  | 'forbidden_key'
  /** The schema declares a type outside the accepted set. */
  | 'forbidden_type'
  /** `anyOf` is present but is not a list of schemas. */
  | 'invalid_any_of'
  /** A numeric bound (`minimum`, `maxLength`, …) is not a number. */
  | 'invalid_bound'
  /** `default` is present but is not a scalar. */
  | 'invalid_default'
  /** `enum` is present but its members are not scalars. */
  | 'invalid_enum'
  /** `properties` is present but is not a map of names to schemas. */
  | 'invalid_properties'
  /** `required` is not a list of property names. */
  | 'invalid_required'
  /** A description or other model-facing string carries a control character. Also thrown for the tool's own description. */
  | 'invalid_text'
  /** The schema nests deeper than the dialect allows. */
  | 'max_depth_exceeded'
  /** The schema declares more properties than the dialect allows. */
  | 'max_properties_exceeded'
  /** A nested schema node is not an object. */
  | 'node_not_object'
  /** The schema refers to itself. */
  | 'recursive_schema'
  /** The top-level schema is not an object. A tool's input is always a set of named parameters. */
  | 'top_level_not_object'
  /** The tool's name does not match the required pattern. */
  | 'invalid_tool_name'
  /** The tool has no description. It is model-facing and required. */
  | 'missing_description'
  /** The tool's description is longer than the protocol allows. */
  | 'description_too_long'
  /** A schema and the type it decodes into disagree. Not thrown by this SDK, which has no consistency-check helper, but declared so a branch ports unchanged. */
  | 'schema_type_mismatch';

/** A tool declaration is invalid — a bad name, a missing or overlong
 *  description, or an input schema that cannot be expressed in the restricted
 *  dialect the realtime backend accepts.
 *
 *  Thrown when the tool is constructed, never at session connect. `code` names
 *  which — switch on it rather than matching the message. */
export class ToolDefinitionError extends RealtimeError {
  /** What is wrong with the declaration. A closed set this SDK throws —
   *  switch on it. */
  readonly code: ToolDefinitionErrorCode;

  constructor(options: { code: ToolDefinitionErrorCode; message: string }) {
    super(options.message !== '' ? options.message : options.code);
    this.name = 'ToolDefinitionError';
    this.code = options.code;
  }
}

/** The model's arguments failed validation inside a builder-synthesized
 *  tool handler. The message follows the normalized ``INVALID_INPUT`` shape
 *  and is built from structured issue fields only — submitted values never
 *  appear. ``issues`` carries the same sanitized issues structurally. */
export class ToolInputValidationError extends RealtimeError {
  /** Every violation found, so a caller can report them all at once
   *  rather than one per round trip. */
  readonly issues: ToolInputIssue[];

  constructor(message: string, options: { issues: ToolInputIssue[] }) {
    super(message);
    this.name = 'ToolInputValidationError';
    this.issues = options.issues;
  }
}

const MAX_ISSUE_LINES = 5;
const MAX_MESSAGE_BYTES = 1024;

/** Build the normalized ``INVALID_INPUT`` message: at most
 *  {@link MAX_ISSUE_LINES} issue lines (then ``… and N more``), shrunk until
 *  the whole message fits {@link MAX_MESSAGE_BYTES}. */
export function formatInvalidInput(toolName: string, issues: ToolInputIssue[]): string {
  const header = `INVALID_INPUT: ${toolName} rejected parameters:`;
  const footer = 'Fix the input and retry.';
  let shown = Math.min(issues.length, MAX_ISSUE_LINES);
  for (;;) {
    const lines = issues
      .slice(0, shown)
      .map((issue) => `- ${issue.path}: ${issue.constraint}`);
    const hidden = issues.length - shown;
    if (hidden > 0) lines.push(`- … and ${hidden} more`);
    const message = [header, ...lines, footer].join('\n');
    if (new TextEncoder().encode(message).length <= MAX_MESSAGE_BYTES || shown === 0) {
      return message;
    }
    shown -= 1;
  }
}
