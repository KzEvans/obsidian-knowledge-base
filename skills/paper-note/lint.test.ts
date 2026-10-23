import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';
import { BANNED_PHRASES, HEDGE_WORDS, lintNote, MAX_BOLD_PER_SECTION, MAX_HEDGES, MAX_LENGTH, MIN_LENGTH, noteLength, SECTIONS } from './lint';

// 20 characters per sentence, no banned phrases, hedges or numbers.
const SENTENCE = '样品在室温下拉伸到两倍长度后保持十分钟。';
const filler = (characters: number) => SENTENCE.repeat(Math.ceil(characters / 20));
const ABSTRACT_TEXT = '这是程序填入的摘要译文。'.repeat(40);

/** A note that passes every rule; `bodies` overrides a section's text. */
function note(bodies: Partial<Record<string, string>> = {}, titles: readonly string[] = SECTIONS): string {
  return titles.map(title => `## ${title}\n\n${bodies[title] ?? (title === '摘要翻译' ? ABSTRACT_TEXT : filler(240))}\n`).join('\n');
}

const rules = (markdown: string) => lintNote(markdown).problems.map(problem => problem.rule);

test('a well-formed note passes', () => {
  const result = lintNote(note());
  assert.deepEqual(result.problems, []);
  assert.equal(result.ok, true);
  assert.ok(result.length >= MIN_LENGTH && result.length <= MAX_LENGTH);
});

test('the banned-phrase and hedge lists load from references/banned-phrases.md', () => {
  assert.ok(BANNED_PHRASES.includes('综上所述'));
  assert.ok(HEDGE_WORDS.includes('可能'));
  assert.ok(!BANNED_PHRASES.includes('可能'));
});

describe('sections', () => {
  test('a missing section is reported', () => {
    const problems = lintNote(note({}, SECTIONS.filter(title => title !== 'Takeaways'))).problems;
    assert.ok(problems.some(problem => problem.rule === 'sections' && problem.section === 'Takeaways'));
  });
  test('an extra second-level heading is reported', () => {
    assert.ok(rules(note() + '\n## 总结\n\n' + filler(20)).includes('sections'));
  });
  test('a repeated section is reported', () => {
    assert.ok(rules(note() + '\n## 研究背景\n\n' + filler(20)).includes('sections'));
  });
  test('sections out of order are reported', () => {
    const swapped = [...SECTIONS];
    [swapped[1], swapped[2]] = [swapped[2]!, swapped[1]!];
    assert.ok(rules(note({}, swapped)).includes('section-order'));
    assert.ok(!rules(note()).includes('section-order'));
  });
  test('protected sections and an H1 title are allowed', () => {
    const markdown = '# 标题\n\n' + note() + '\n## 人工复核\n\n![[x.png]] 综上所述 **a** **b** **c**\n\n# 提问\n\n#page=3\n';
    assert.deepEqual(lintNote(markdown).problems, []);
  });
});

test('the model frontmatter with the four link lists is ignored', () => {
  const frontmatter = '---\nconcepts: ["[[玻璃化转变]]"]\nmaterials: []\nmethods: ["[[动态力学分析]]"]\nphenomena: []\n---\n';
  const result = lintNote(frontmatter + note());
  assert.deepEqual(result.problems, []);
  assert.equal(result.length, lintNote(note()).length);
});

describe('page links and embeds', () => {
  test('#page= links are reported', () => {
    assert.ok(rules(note({ 研究背景: filler(240) + '[[paper.pdf#page=3|p.3]]' })).includes('page-link'));
  });
  test('image embeds are reported', () => {
    assert.ok(rules(note({ 研究背景: filler(240) + '\n\n![[fig1.png]]' })).includes('embed'));
    assert.ok(rules(note({ 研究背景: filler(240) + '\n\n![图](images/fig1.png)' })).includes('embed'));
  });
  test('ordinary wiki links are fine', () => {
    assert.deepEqual(rules(note({ 与现有知识的候选关联: '- [[瞬态网络]]：' + filler(240) })), []);
  });
});

describe('banned phrases', () => {
  test('each listed phrase is reported with its line', () => {
    const markdown = note({ 研究背景: filler(240) + '\n\n综上所述，网络更软。' });
    const problem = lintNote(markdown).problems.find(found => found.rule === 'banned-phrase');
    assert.ok(problem);
    assert.equal(problem.section, '研究背景');
    assert.equal(markdown.split('\n')[(problem.line ?? 0) - 1], '综上所述，网络更软。');
  });
  test('…… in a phrase matches text inside one sentence', () => {
    assert.ok(rules(note({ 研究背景: filler(240) + '这为柔性器件指明了方向。' })).includes('banned-phrase'));
    assert.ok(!rules(note({ 研究背景: filler(240) + '这为柔性器件。另一组指明了方向' })).includes('banned-phrase'));
  });
  test('the abstract translation is not checked', () => {
    assert.deepEqual(rules(note({ 摘要翻译: ABSTRACT_TEXT + '综上所述，**一**、**二**、**三**。' })), []);
  });
});

describe('hedges', () => {
  test(`more than ${MAX_HEDGES} hedge words are reported`, () => {
    assert.ok(rules(note({ 研究背景: filler(240) + '可能更软。'.repeat(MAX_HEDGES + 1) })).includes('hedges'));
  });
  test(`${MAX_HEDGES} hedge words pass, and 不可能 is not a hedge`, () => {
    assert.ok(!rules(note({ 研究背景: filler(240) + '可能更软。'.repeat(MAX_HEDGES) + '不可能更软。'.repeat(5) })).includes('hedges'));
  });
});

describe('bold', () => {
  test(`more than ${MAX_BOLD_PER_SECTION} bold spans in one section are reported`, () => {
    const result = lintNote(note({ 研究背景: filler(240) + '**甲**、**乙**和**丙**。' }));
    assert.ok(result.problems.some(problem => problem.rule === 'bold' && problem.section === '研究背景'));
  });
  test(`${MAX_BOLD_PER_SECTION} bold spans in each section pass`, () => {
    assert.deepEqual(rules(note({ 研究背景: filler(240) + '**甲**和**乙**。', Takeaways: filler(240) + '**丙**。' })), []);
  });
  test('bold used as a line label is reported', () => {
    assert.ok(rules(note({ 研究背景: filler(240) + '\n\n**机理：**交联点解离。' })).includes('bold-label'));
    assert.ok(rules(note({ 研究背景: filler(240) + '\n\n- **机理**：交联点解离。' })).includes('bold-label'));
    assert.ok(!rules(note({ 研究背景: filler(240) + '\n\n关键在于**交联点解离**。' })).includes('bold-label'));
  });
});

describe('heading levels', () => {
  test('## followed by #### is reported', () => {
    const problems = lintNote(note({ 研究背景: '#### 细节\n\n' + filler(240) })).problems;
    assert.ok(problems.some(problem => problem.rule === 'heading-skip'));
  });
  test('## then ### then #### passes', () => {
    assert.deepEqual(rules(note({ 研究背景: '### 问题\n\n#### 细节\n\n' + filler(240) })), []);
  });
  test('headings inside code fences are ignored', () => {
    assert.deepEqual(rules(note({ 研究背景: '```\n#### 不是标题\n```\n\n' + filler(240) })), []);
  });
});

describe('length', () => {
  test('a short body is reported', () => {
    const bodies = Object.fromEntries(SECTIONS.slice(1).map(title => [title, filler(60)]));
    assert.ok(rules(note(bodies)).includes('length'));
  });
  test('a long body is reported', () => {
    const bodies = Object.fromEntries(SECTIONS.slice(1).map(title => [title, filler(800)]));
    assert.ok(rules(note(bodies)).includes('length'));
  });
  test('frontmatter, the abstract and protected regions do not count', () => {
    const plain = lintNote(note()).length;
    const extra = '---\ntitle: 很长的标题很长的标题\n---\n' + note() + '\n<!-- user-notes:start -->\n' + filler(4000) + '\n<!-- user-notes:end -->\n';
    assert.equal(lintNote(extra).length, plain);
    assert.equal(lintNote(note(), { includeAbstractInLength: true }).length, plain + noteLength(ABSTRACT_TEXT));
  });
  test('a Latin word or number counts as one', () => {
    assert.equal(noteLength('SIS 网络在 25 °C 下松弛'), 9);
    assert.equal(noteLength('**模量**降到 [[瞬态网络]]'), 8);
  });
});

describe('numbers in 论点与证据', () => {
  test('a dense table of numbers is reported', () => {
    const body = '- 更软 → 拉伸测试（图 2）：模量 12 kPa、断裂伸长 850%、强度 1.2 MPa、韧性 3.4 MJ/m3。\n'.repeat(4);
    assert.ok(rules(note({ 论点与证据: body + filler(100) })).includes('evidence-numbers'));
  });
  test('figure and table labels do not count as numbers', () => {
    const body = '- 网络更软 → 拉伸测试（图 2、图 3a，表 1，Fig. 4，Eq. 5）。\n'.repeat(4) + '- 驱动电压更低 → 应变只需 12 V/μm。\n';
    assert.ok(!rules(note({ 论点与证据: body + filler(200) })).includes('evidence-numbers'));
  });
});

test('empty input returns the frozen shape and reports missing sections', () => {
  const result = lintNote('');
  assert.equal(result.ok, false);
  assert.equal(result.length, 0);
  assert.ok(result.problems.some(problem => problem.rule === 'sections'));
});

test('code examples cannot create protected sections or markers that swallow the prose after them', () => {
  for (const example of ['```markdown\n## 人工复核\n```', '```markdown\n<!-- user-notes:start -->\n```', '````markdown\n```\n## 人工复核\n````']) {
    const plain = note();
    const withCode = note({ 研究背景: filler(240) + '\n\n' + example });
    assert.equal(lintNote(withCode).length, lintNote(plain).length);
    assert.deepEqual(rules(withCode), []);
  }
});

test('the program title does not change body length', () => {
  assert.equal(lintNote('# 程序生成的论文标题和作者\n\n' + note()).length, lintNote(note()).length);
});

test('reference-style image embeds are rejected in full, collapsed and shortcut forms', () => {
  for (const image of ['![图][figure]', '![figure][]', '![figure]']) {
    assert.ok(rules(note({ 研究背景: filler(240) + '\n\n' + image + '\n\n[figure]: images/figure.png' })).includes('embed'));
  }
});

test('reference citations do not count as measurements but actual values still do', () => {
  const citations = Array.from({ length: 12 }, (_, i) => `[${i + 1}]`).join(' ');
  assert.ok(!rules(note({ 论点与证据: filler(300) + citations + ' [2–4] [6, 8–10]' })).includes('evidence-numbers'));
  assert.ok(rules(note({ 论点与证据: filler(100) + '模量 1 2 3 4 5 6 7 8 9 10 kPa。' })).includes('evidence-numbers'));
});

test('underscore bold labels are rejected just like asterisk labels', () => {
  for (const label of ['__机理：__交联点解离。', '__机理__：交联点解离。']) {
    assert.ok(rules(note({ 研究背景: filler(240) + '\n\n' + label })).includes('bold-label'));
  }
});

test('a sentence over the length limit is reported; wiki-link titles and normal sentences are not', () => {
  const long = '短端块先从胶束核中拔出使桥链失去承载能力而长端块仍然锚定在原来的胶束核里因此整条链要等到长端块也拔出之后才能真正迁移到另一个胶束这一过程比应力松弛慢得多并且对长端块的长度极其敏感所以分散性会放大两个时间尺度之间的差距使得网络在宏观上已经流动而微观上仍未完成链交换。';
  assert.ok(rules(note({ 研究背景: long })).includes('long-sentence'));
  const linked = '- [[2026-10-12 - Fanlong Meng - Stress Relaxation, Dynamics, and Plasticity of Transient Polymer Networks in Concentrated Solutions]]：可对照承载链存活的理论。';
  assert.ok(!rules(note({ 与现有知识的候选关联: linked })).includes('long-sentence'));
  assert.ok(!rules(note()).includes('long-sentence'));
});
