/**
 * ``ToolInput`` — the vendor-free contract between a schema converter and
 * the core ``clientTool()`` builder: a validate function plus the already-converted
 * dialect JSON Schema.
 *
 * The type is nominally branded with a non-exported ``unique symbol``, so a
 * structurally-shaped object literal does not satisfy it: only converter
 * entry points (``zodInput`` today) can mint one, which makes "input must be
 * convertible" a compile-time fact rather than a construction-time throw.
 * The brand is type-level only; nothing extra is serialized.
 */

import type { ToolInputIssue } from './errors';

/** Brand that keeps a hand-written object from passing as a ``ToolInput``;
 *  only a converter entry point can mint one. @internal */
declare const TOOL_INPUT_BRAND: unique symbol;

/** A converter's validate outcome: the parsed (possibly transformed) value,
 *  or sanitized issues built from structured fields only. */
export type ToolInputParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: ToolInputIssue[] };

/** A validator + dialect-converted schema pair, minted only by converter
 *  entry points (e.g. ``zodInput`` from ``cosmo-ai/tool/zod``). */
export type ToolInput<T> = {
  readonly [TOOL_INPUT_BRAND]: true;
  /** Wire-ready dialect JSON Schema describing the accepted input. */
  readonly parameters: Record<string, unknown>;
  /** Validate raw args; issues must already be sanitized (no submitted
   *  values). */
  readonly validate: (
    args: Record<string, unknown>,
  ) => Promise<ToolInputParseResult<T>>;
};

/** @internal — converter-only constructor for {@link ToolInput}. Not
 *  exported from any public entry point. */
export function mintToolInput<T>(options: {
  parameters: Record<string, unknown>;
  validate: (args: Record<string, unknown>) => Promise<ToolInputParseResult<T>>;
}): ToolInput<T> {
  return {
    parameters: options.parameters,
    validate: options.validate,
  } as ToolInput<T>;
}
