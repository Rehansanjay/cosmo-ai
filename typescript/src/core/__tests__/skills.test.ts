/** ``SKILL.md`` parsing, resolving the ``skills`` array, the resident menu,
 *  and the ``cosmo_sdk_load_skill`` tool builder. Python's
 *  ``tests/test_skills.py`` is the cross-SDK reference. */

import type { SkillErrorCode } from '../skills';
import { describe, expect, it } from 'vitest';

import {
  LOAD_SKILL_TOOL_NAME,
  PRIVATE_INSTRUCTIONS_PREFIX,
  SkillError,
  buildLoadSkillTool,
  menuText,
  parseSkillMd,
  resolveSkills,
  type Skill,
} from '../skills';
import { isSdkClientTool } from '../../tool/sdk_tool';

const BILLING_MD = `---
name: billing
description: Handle plan and invoice questions.
---
Always confirm the account id first.`;

function makeSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    name: 'billing',
    description: 'Handle plan and invoice questions.',
    body: 'Always confirm the account id first.',
    ...overrides,
  };
}

/** The code is the contract; the message is not. Asserting on prose is what
 *  the code was added to replace. */
function skillErrorCode(fn: () => unknown): SkillErrorCode {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(SkillError);
    return (err as SkillError).code;
  }
  throw new Error('expected a SkillError');
}

describe('parseSkillMd', () => {
  it('parses frontmatter and body', () => {
    const skill = parseSkillMd(BILLING_MD, 'dir-name');
    expect(skill).toEqual({
      name: 'billing',
      description: 'Handle plan and invoice questions.',
      body: 'Always confirm the account id first.',
    });
  });

  it('defaults the name to the directory name when absent', () => {
    const text = '---\ndescription: d\n---\nbody';
    expect(parseSkillMd(text, 'refunds').name).toBe('refunds');
  });

  it('rejects a document without a frontmatter fence', () => {
    expect(skillErrorCode(() => parseSkillMd('no fence', 'x'))).toBe(
      'missing_frontmatter',
    );
  });

  it('rejects an unterminated frontmatter fence', () => {
    expect(
      skillErrorCode(() => parseSkillMd('---\ndescription: d\n', 'x')),
    ).toBe('unterminated_frontmatter');
  });

  it('rejects missing description', () => {
    expect(
      skillErrorCode(() => parseSkillMd('---\nname: a\n---\nbody', 'x')),
    ).toBe('missing_description');
  });

  it('preserves a description containing a colon', () => {
    const text = '---\ndescription: Use when: the caller asks for billing\n---\n';
    expect(parseSkillMd(text, 'x').description).toBe(
      'Use when: the caller asks for billing',
    );
  });

  it('rejects a duplicate frontmatter key', () => {
    const text = '---\ndescription: a\ndescription: b\n---\n';
    expect(skillErrorCode(() => parseSkillMd(text, 'x'))).toBe(
      'duplicate_frontmatter_key',
    );
  });

  it('rejects a malformed frontmatter line', () => {
    const text = '---\ndescription: d\nnot a mapping\n---\n';
    expect(skillErrorCode(() => parseSkillMd(text, 'x'))).toBe(
      'malformed_frontmatter_line',
    );
  });

  it('ignores unknown frontmatter keys so other-harness files stay valid', () => {
    const text =
      '---\ndescription: d\ntier: search\nallowed-tools: [a, b]\nlicense: MIT\n---\nbody';
    expect(parseSkillMd(text, 'x')).toEqual({
      name: 'x',
      description: 'd',
      body: 'body',
    });
  });

  it('parses CRLF documents and block-list values under ignored keys', () => {
    const text =
      '---\r\nname: activate-card\r\ndescription: Activate a card.\r\n' +
      'allowed-tools:\r\n  - Bash\r\n  - Read\r\n---\r\nBody line.\r\n';
    expect(parseSkillMd(text, 'ignored')).toEqual({
      name: 'activate-card',
      description: 'Activate a card.',
      body: 'Body line.',
    });
  });
});

describe('resolveSkills', () => {
  it('passes a unique list through', () => {
    const skills = [makeSkill(), makeSkill({ name: 'refunds' })];
    expect(resolveSkills(skills)).toEqual(skills);
  });

  it('rejects duplicate names', () => {
    expect(skillErrorCode(() => resolveSkills([makeSkill(), makeSkill()]))).toBe(
      'duplicate_skill_name',
    );
  });
});

describe('menuText', () => {
  it('lists every skill', () => {
    const menu = menuText([
      makeSkill(),
      makeSkill({ name: 'escalation', description: 'Hand off to a human.' }),
    ]);
    expect(menu).toContain('## Skills');
    expect(menu).toContain('- billing: Handle plan and invoice questions.');
    expect(menu).toContain('- escalation: Hand off to a human.');
  });

  it('is empty with no skills', () => {
    expect(menuText([])).toBe('');
  });
});

describe('buildLoadSkillTool', () => {
  it('declares cosmo_sdk_load_skill as an SDK-marked tool with the skill names as the enum', () => {
    const tool = buildLoadSkillTool([makeSkill(), makeSkill({ name: 'refunds' })]);
    expect(tool?.name).toBe(LOAD_SKILL_TOOL_NAME);
    expect(LOAD_SKILL_TOOL_NAME).toBe('cosmo_sdk_load_skill');
    // Marked so the reserved-namespace guard exempts the SDK's own tool by type.
    expect(tool !== null && isSdkClientTool(tool)).toBe(true);
    expect(tool?.parameters).toMatchObject({
      type: 'object',
      properties: { name: { type: 'string', enum: ['billing', 'refunds'] } },
      required: ['name'],
    });
  });

  it('handler returns the body wrapped in the private-instructions envelope', async () => {
    const tool = buildLoadSkillTool([makeSkill()]);
    const result = await tool?.handler?.({ name: 'billing' });
    expect(result).toEqual({
      instructions: `${PRIVATE_INSTRUCTIONS_PREFIX}Always confirm the account id first.`,
    });
  });

  it('handler rejects an unknown skill with the available names', async () => {
    const tool = buildLoadSkillTool([makeSkill()]);
    await expect(tool?.handler?.({ name: 'nope' })).rejects.toThrow(
      /unknown skill "nope"; available: \["billing"\]/,
    );
  });

  it('returns null when there are no skills', () => {
    expect(buildLoadSkillTool([])).toBeNull();
  });
});
