import { describe, expect, it } from 'vitest';

import { DelegationTranscripts } from '../delegation_transcript';
import type { TranscriptItem } from '../events';

function transcript(...turns: [TranscriptItem['role'], string][]): TranscriptItem[] {
  return turns.map(([role, text], index) => ({
    id: `t${index}`,
    role,
    text,
    isFinal: true,
  }));
}

describe('DelegationTranscripts', () => {
  it('keeps what the provider sent', () => {
    const resolver = new DelegationTranscripts();

    expect(
      resolver.resolve('d1', 'where is my order', transcript(['user', 'something else'])),
    ).toBe('where is my order');
  });

  it('stands the last user turn in for a hand-off that carried nothing', () => {
    const resolver = new DelegationTranscripts();
    const items = transcript(
      ['user', 'lets begin'],
      ['assistant', 'Question one…'],
      ['user', 'option B'],
    );

    expect(resolver.resolve('d1', '', items)).toBe('option B');
  });

  it('resolves one hand-off once, so callback and stream agree', () => {
    const resolver = new DelegationTranscripts();
    const items = transcript(['user', 'option B']);

    expect(resolver.resolve('d1', '', items)).toBe('option B');
    expect(resolver.resolve('d1', '', [...items, ...transcript(['user', 'lock it'])])).toBe(
      'option B',
    );
  });

  it('never replays one user turn for two blank hand-offs', () => {
    const resolver = new DelegationTranscripts();
    const items = transcript(['user', 'option B']);

    expect(resolver.resolve('d1', '', items)).toBe('option B');
    expect(resolver.resolve('d2', '', items)).toBe('');
  });

  it('never stands in a turn the provider already named', () => {
    const resolver = new DelegationTranscripts();
    const items = transcript(['user', 'option B']);

    expect(resolver.resolve('d1', 'option B', items)).toBe('option B');
    expect(resolver.resolve('d2', '', items)).toBe('');
  });

  it('has nothing to offer before the user has said anything', () => {
    const resolver = new DelegationTranscripts();

    expect(resolver.resolve('d1', '', transcript(['assistant', 'Welcome!']))).toBe('');
    expect(resolver.resolve('d2', '   ', [])).toBe('');
  });
});
