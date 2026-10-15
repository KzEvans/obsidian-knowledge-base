"""Pure canonical normalization fixtures; no model or live vault is involved."""
import importlib.util
from pathlib import Path
import sys
import unittest


DIRECTORY = Path(__file__).resolve().parents[1] / "knowledge-base/system/knowledge"
if str(DIRECTORY) not in sys.path:
    sys.path.insert(0, str(DIRECTORY))
SPEC = importlib.util.spec_from_file_location("canonical_merge", DIRECTORY / "canonical_merge.py")
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)


class CanonicalMergeTests(unittest.TestCase):
    def merge(self, before, candidate, path="wiki/concepts/网络.md"):
        return M.merge_canonical_content(before, candidate, path, "2026-10-12")

    def test_byte_identical_fast_path_does_not_stamp_updated(self):
        original = '---\ntype: concept\ntitle: 网络\nupdated: 2026-01-01\n---\n# 网络\n'
        result, details = self.merge(original, original)
        self.assertEqual(result, original)
        self.assertFalse(details["changed"])
        self.assertEqual(details["mode"], "identical")
        self.assertEqual(details["model_calls"], 0)

    def test_arrays_union_and_identity_fields_restore_without_changing_body(self):
        before = ('---\ntype: concept\ntitle: 瞬态网络\ncreated: 2026-01-01\n'
                  'sources: ["old.pdf"]\ntags:\n  - 聚合物\nrelated: [交联]\naliases: [动态网络]\n---\n# 内容\n')
        candidate = ('---\ntype: material\ntitle: 错误改名\ncreated: 2026-10-12\n'
                     'sources: ["new.pdf"]\ntags: [力学]\nrelated: [松弛]\naliases: [可重连网络]\n---\n# 内容\n')
        result, details = self.merge(before, candidate)
        fields = M.I._frontmatter(result)
        for key, expected in [("type", "concept"), ("title", "瞬态网络"), ("created", "2026-01-01")]:
            self.assertEqual(M.I._scalar(fields[key][0]), expected)
        self.assertEqual(M.I._list(fields, "sources"), ["old.pdf", "new.pdf"])
        self.assertEqual(M.I._list(fields, "tags"), ["聚合物", "力学"])
        self.assertEqual(M.I._list(fields, "related"), ["交联", "松弛"])
        self.assertEqual(M.I._list(fields, "aliases"), ["动态网络", "可重连网络"])
        self.assertEqual(M.I._scalar(fields["updated"][0]), "2026-10-12")
        self.assertEqual(details["mode"], "metadata_only")
        self.assertEqual(details["model_calls"], 0)
        self.assertTrue(result.endswith('# 内容\n'))

    def test_omitted_existing_fields_are_restored_and_opaque_metadata_survives(self):
        before = '---\ntype: concept\ntitle: 网络\ncreated: 2026-01-01\nsources: [a.pdf]\n---\n# 原文\n'
        candidate = '---\ncustom: {owner: human}\n# Human metadata comment\ntags: [力学]\n---\n# 新候选\n'
        result, details = self.merge(before, candidate)
        self.assertIn('custom: {owner: human}', result)
        self.assertIn('# Human metadata comment', result)
        self.assertEqual(set(details["locked_fields_restored"]), {"type", "title", "created"})
        self.assertEqual(M.I._list(M.I._frontmatter(result), "sources"), ["a.pdf"])

    def test_existing_question_state_and_priority_are_locked(self):
        before = ('---\ntype: question\ntitle: 为什么松弛\ncreated: 2026-01-01\n'
                  'status: closed\nquestion_status: answered\npriority: high\n---\n# 问题\n')
        candidate = before.replace('closed', 'open').replace('answered', 'pending').replace('high', 'low') + '\n新证据。\n'
        result, details = self.merge(before, candidate, 'wiki/questions/为什么松弛.md')
        fields = M.I._frontmatter(result)
        self.assertEqual(M.I._scalar(fields['status'][0]), 'closed')
        self.assertEqual(M.I._scalar(fields['question_status'][0]), 'answered')
        self.assertEqual(M.I._scalar(fields['priority'][0]), 'high')
        self.assertTrue(set(M._QUESTION_FIELDS).issubset(details['locked_fields_restored']))

    def test_numeric_question_priority_keeps_its_original_scalar_representation(self):
        before = '---\ntype: question\ntitle: 问题\npriority: 3\n---\n# 问题\n'
        candidate = before.replace('priority: 3', 'priority: 1') + '\n新证据。\n'
        result, _ = self.merge(before, candidate, 'wiki/questions/问题.md')
        self.assertIn('\npriority: 3\n', result)
        self.assertNotIn('priority: "3"', result)

    def test_unrecognized_existing_metadata_is_preserved_verbatim_when_omitted(self):
        before = ('---\ntype: concept\ntitle: 网络\ncustom:\n'
                  '  owner: human\n  options: {show: true}\n---\n# 内容\n')
        candidate = '---\ntype: concept\ntitle: 网络\n---\n# 新候选\n'
        result, details = self.merge(before, candidate)
        self.assertIn('custom:\n  owner: human\n  options: {show: true}', result)
        self.assertEqual(details['preserved_extra_fields'], ['custom'])

    def test_new_question_status_is_not_changed_or_defaulted(self):
        candidate = '---\ntype: question\ntitle: 新问题\nstatus: pending\n---\n# 新问题\n'
        result, details = self.merge('', candidate, 'wiki/questions/新问题.md')
        fields = M.I._frontmatter(result)
        self.assertEqual(M.I._scalar(fields['status'][0]), 'pending')
        self.assertNotIn('question_status', fields)
        self.assertEqual(details['mode'], 'new_page')

    def test_only_exact_same_source_condition_paragraphs_are_deduplicated(self):
        paragraph = '25 °C、0.1 s⁻¹下应力松弛。 <!-- kb-claim:claim-a --> [[sources/a.pdf#page=3|p.3]]'
        other_condition = paragraph.replace('25 °C', '130 °C')
        other_source = paragraph.replace('sources/a.pdf', 'sources/b.pdf')
        candidate = '# 结果\n\n' + '\n\n'.join([paragraph, paragraph, other_condition, other_source]) + '\n'
        result, details = self.merge('', candidate)
        self.assertEqual(result.count(paragraph), 1)
        self.assertIn(other_condition, result)
        self.assertIn(other_source, result)
        self.assertEqual(details['deduplicated_blocks'], 1)

    def test_distinct_headings_and_tables_keep_intentional_cross_references(self):
        row = '| 25 °C松弛 <!-- kb-claim:claim-a --> | [[sources/a.pdf#page=3\\|p.3]] |'
        table = '| 条件 | 来源 |\n|---|---|\n' + row + '\n'
        candidate = '# 对比\n\n' + table + '\n## 方法\n\n' + table
        result, details = self.merge('', candidate)
        self.assertEqual(result.count(row), 2)
        self.assertEqual(details['deduplicated_blocks'], 0)

    def test_exact_repeated_evidence_rows_within_one_table_are_removed(self):
        row = '| 25 °C松弛 <!-- kb-claim:claim-a --> | [[sources/a.pdf#page=3\\|p.3]] |'
        candidate = '# 对比\n\n| 条件 | 来源 |\n|---|---|\n' + row + '\n' + row + '\n'
        result, details = self.merge('', candidate)
        self.assertEqual(result.count(row), 1)
        self.assertEqual(details['deduplicated_blocks'], 1)

    def test_human_blocks_review_sections_and_fenced_examples_are_not_deduplicated(self):
        evidence = '个人观察。 [[sources/a.pdf#page=3|p.3]]'
        human = '<!-- user-notes:start -->\n' + evidence + '\n\n' + evidence + '\n<!-- user-notes:end -->'
        review = '## 人工复核\n\n' + evidence + '\n\n' + evidence
        code = '```markdown\n' + evidence + '\n\n' + evidence + '\n```'
        candidate = '# 页面\n\n' + human + '\n\n' + review + '\n\n## 样例\n\n' + code + '\n'
        result, details = self.merge('', candidate)
        self.assertIn(human, result)
        self.assertIn(review, result)
        self.assertIn(code, result)
        self.assertEqual(details['deduplicated_blocks'], 0)

    def test_plain_prose_and_source_free_duplicates_are_not_semantically_merged(self):
        candidate = '# 解释\n\n网络可能松弛。\n\n网络可能松弛。\n'
        result, details = self.merge('', candidate)
        self.assertEqual(result, candidate)
        self.assertEqual(details['deduplicated_blocks'], 0)

    def test_shortening_is_diagnostic_and_does_not_create_an_incoming_body_fallback(self):
        before = '# 证据\n\n' + '长的实验条件。' * 40 + ' <!-- kb-claim:claim-old --> [[sources/a.pdf#page=3]]\n'
        candidate = '# 证据\n\n短候选。 [[sources/a.pdf#page=3]]\n'
        result, details = self.merge(before, candidate)
        self.assertEqual(result, candidate)
        self.assertEqual({item['kind'] for item in details['diagnostics']},
                         {'body_shortened', 'old_claim_markers_missing'})
        self.assertEqual(details['diagnostics'][1]['claim_ids'], ['claim-old'])
        self.assertEqual(details['model_calls'], 0)

    def test_owned_metadata_parse_errors_raise_without_fallback(self):
        before = '---\ntype: concept\ntitle: 网络\nsources: [a.pdf]\n---\n# 内容\n'
        for candidate in [
            before.replace('sources: [a.pdf]', 'sources: {bad: mapping}'),
            before.replace('title: 网络', 'title: [malformed]'),
            before.replace('type: concept', 'type: concept\ntype: material'),
            '---\nsources: [a.pdf]\n# No closing metadata fence',
            '# Incoming missing required existing frontmatter\n',
        ]:
            with self.subTest(candidate=candidate), self.assertRaises(RuntimeError):
                self.merge(before, candidate)
        self.assertEqual(before, '---\ntype: concept\ntitle: 网络\nsources: [a.pdf]\n---\n# 内容\n')

    def test_existing_list_errors_are_not_discarded(self):
        before = '---\ntype: concept\nsources: {bad: mapping}\n---\n# 内容\n'
        candidate = '---\ntype: concept\nsources: [a.pdf]\n---\n# 新内容\n'
        with self.assertRaisesRegex(RuntimeError, 'unknown_list'):
            self.merge(before, candidate)

    def test_crlf_and_quoted_array_formats_preserve_body_and_chinese_citations(self):
        body = '# 结果\r\n\r\n“条件相同”尚待核验。 [[sources/中文 论文.pdf#page=4|原文第4页]]\r\n'
        before = '---\r\ntype: concept\r\ntitle: "中文网络"\r\nsources: [\'甲.pdf\']\r\n---\r\n' + body
        candidate = '---\r\ntype: concept\r\ntitle: 中文网络\r\nsources:\r\n  - "乙.pdf"\r\n---\r\n' + body
        result, details = self.merge(before, candidate)
        self.assertTrue(result.endswith(body))
        self.assertEqual(M.I._list(M.I._frontmatter(result), 'sources'), ['甲.pdf', '乙.pdf'])
        self.assertEqual(details['mode'], 'metadata_only')

    def test_locked_only_changes_can_normalize_to_no_op(self):
        before = '---\ntype: "concept"\ntitle: "网络"\ncreated: "2026-01-01"\n---\n# 内容\n'
        candidate = before.replace('"网络"', '"错误名称"')
        result, details = self.merge(before, candidate)
        self.assertEqual(result, before)
        self.assertFalse(details['changed'])
        self.assertEqual(details['mode'], 'normalized_no_op')

    def test_source_notes_are_outside_the_pure_canonical_api(self):
        with self.assertRaisesRegex(RuntimeError, 'noncanonical_path'):
            self.merge('# old', '# new', 'wiki/papers/Paper.md')


if __name__ == '__main__':
    unittest.main()
