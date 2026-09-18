import type { AgentTool } from 'cosmo-ai';
import { describe, expect, it } from 'vitest';

/** The declared shape of a client tool, for code that reads back what it built.
 *  The SDK keeps its per-tool models internal — a tool is built by calling a
 *  constructor and ``AgentTool`` is the only tool type it publishes. */
type Declared = {
  kind: 'client';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler?: (args: Record<string, unknown>) => Promise<unknown>;
};

const declared = (t: AgentTool): Declared => t as unknown as Declared;

import { makeAnalyzePositionTool } from './analyze_position';
import type { UciEngine } from './engine';

describe('makeAnalyzePositionTool', () => {
  // tool() validates the name and emitted JSON Schema against the backend's
  // restricted dialect at construction, so this pins "the server would
  // accept this tool" without a session.
  it('constructs a client tool spec the server accepts', () => {
    const spec = makeAnalyzePositionTool(() => {
      throw new Error('engine must not start at construction time');
    });
    expect(declared(spec).kind).toBe('client');
    expect(declared(spec).name).toBe('analyze_position');
    expect(declared(spec).parameters).toMatchObject({
      type: 'object',
      required: ['position', 'side_to_move'],
    });
  });

  it('rejects a malformed model call before the engine is touched', async () => {
    const spec = makeAnalyzePositionTool(() => {
      throw new Error('engine must not start on invalid input');
    });
    await expect(
      declared(spec).handler!({ position: 'x', side_to_move: 'purple' }),
    ).rejects.toThrow();
  });

  it('runs the handler against a stubbed engine', async () => {
    const engine = {
      analyze: async () => [
        { multipv: 1, depth: 12, scoreCp: 45, mateIn: null, pv: ['e2e4', 'e7e5'] },
      ],
    } as unknown as UciEngine;
    const result = (await declared(makeAnalyzePositionTool(() => engine)).handler!({
      position: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR',
      side_to_move: 'white',
    })) as Record<string, unknown>;
    expect(result.status).toBe('ok');
    expect(result.top_moves).toEqual([
      { rank: 1, move: 'e4', eval: '+0.45', line: ['e4', 'e5'] },
    ]);
  });
});
