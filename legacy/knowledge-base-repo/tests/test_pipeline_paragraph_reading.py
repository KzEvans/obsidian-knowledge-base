import importlib.util
import json
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock


MODULE_PATH = (
    Path(__file__).resolve().parents[1]
    / "knowledge-base"
    / "system"
    / "knowledge"
    / "run_pipeline.py"
)
SPEC = importlib.util.spec_from_file_location("run_pipeline_paragraph_reading", MODULE_PATH)
assert SPEC and SPEC.loader
PIPELINE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PIPELINE)


class PipelineParagraphReadingTest(unittest.TestCase):
    def make_task(self):
        task = PIPELINE.paper_note_identity(
            {"title": "A valuable paper", "creators": ["First Author"]},
            "2026-09-02",
        )
        task.update(PIPELINE.paper_paragraph_reading_identity(task["note_path"]))
        task.update(
            {
                "id": "paper:ATTACH:0123456789abcdef",
                "kind": "paper",
                "status": "drafted",
                "source_path": "sources/literature/pdf/paper.pdf",
                "extract_path": "extracts/papers/ATTACH.md",
                "title": "A valuable paper",
                "paragraph_reading_figures": False,
            }
        )
        task["paragraph_reading_images_dir"] = (
            Path(task["images_dir"]) / PIPELINE.PAPER_INTENSIVE_IMAGES_SUBDIR
        ).as_posix()
        return task

    def make_log(
        self,
        task,
        *,
        stage="awaiting_initial_analysis",
        covered=0,
        total=2,
        score=None,
        progress="partial",
        verified_units="",
        merged_units="",
        initial_answer="",
        visual_path=None,
    ):
        score_value = "null" if score is None else str(score)
        visual_block = f"\n![[{visual_path}]]\n" if visual_path else ""
        verified_block = ""
        if stage == "ready_to_merge":
            verified_block = (
                "\n<!-- verified-unit:U01:start -->\n"
                "##### 已验证共同结论（U01）\n\n"
                "- 核心结论：Verified\n"
                "- 证据定位：见本单元“原文位置”\n"
                "<!-- verified-unit:U01:end -->\n"
            )
        return (
            "---\n"
            "type: paper-intensive-reading-log\n"
            "status: draft\n"
            "reading_mode: A\n"
            "workflow: full-text-unlabeled-paragraph-pairs\n"
            "integration_role: auxiliary\n"
            f'primary_source_id: "{task["id"]}"\n'
            f'source_note: "[[{task["note_path"]}]]"\n'
            f'source_pdf: "[[{task["source_path"]}]]"\n'
            f'extract: "[[{task["extract_path"]}]]"\n'
            "pdf_extractor: mineru\n"
            f'images_dir: "{task["images_dir"]}"\n'
            f'intensive_images_dir: "{task["paragraph_reading_images_dir"]}"\n'
            "source_display: unlabeled-extracted-paragraph-pairs\n"
            "allow_image_crops: true\n"
            "allow_optional_image_crops: false\n"
            f"paragraph_reading_progress: {progress}\n"
            f"interaction_stage: {stage}\n"
            "current_unit: U01\n"
            f"current_unit_score: {score_value}\n"
            f"covered_units: {covered}\n"
            f"total_units: {total}\n"
            f'verified_units: "{verified_units}"\n'
            f'merged_units: "{merged_units}"\n'
            "last_completed_locator: null\n"
            "---\n\n"
            f"# {task['display_title']}：逐段精读验证日志\n\n"
            "## 全文推理单元地图\n\n- [ ] U01 · 当前：awaiting_initial_analysis\n\n"
            "## 交互精读\n\n### U01\n\n"
            "#### 原文与翻译\n\n"
            "##### P01\n\n"
            "Source evidence paragraph.\n\n"
            "<!-- pair:P01:split -->\n\n"
            "来源证据段落。\n"
            f"{visual_block}\n"
            "#### 原文位置\n\n"
            f"[[{task['source_path']}#page=1|PDF p.1]]\n\n"
            "#### 交互\n\n##### 用户初始理解（请填写）\n\n"
            "<!-- initial-understanding:U01:start -->\n"
            f"- 我目前的理解：{initial_answer}\n"
            "- 我不确定的是：\n"
            "<!-- initial-understanding:U01:end -->\n"
            f"{verified_block}\n"
            "## Agentic Q&A\n\n## 完成检查\n\n## 知识增长候选\n\n"
            "## 人工笔记\n<!-- user-notes:start -->\n<!-- user-notes:end -->\n"
        )

    def prepare_vault(self, vault, task):
        source = vault / task["source_path"]
        source.parent.mkdir(parents=True)
        source.write_bytes(b"paper pdf")
        task["sha256"] = PIPELINE.file_sha256(source)
        extract = vault / task["extract_path"]
        extract.parent.mkdir(parents=True)
        extract.write_text(
            "---\ntype: extracted-paper\nextractor: mineru\n---\n\n"
            "## Page 1\n\nSource evidence",
            encoding="utf-8",
        )
        main_note = vault / task["note_path"]
        main_note.parent.mkdir(parents=True)
        main_note.write_text(
            "---\ntype: paper\nstatus: draft\nparagraph_reading: true\n"
            "paragraph_reading_figures: false\n"
            "paragraph_reading_status: not_requested\n"
            "paragraph_reading_note: null\n---\n\n# Main\n\nOriginal body.\n",
            encoding="utf-8",
        )
        queue_file = vault / "system/queue/pending.json"
        queue_file.parent.mkdir(parents=True)
        queue_file.write_text(
            json.dumps({"schema_version": 1, "items": [task]}),
            encoding="utf-8",
        )
        image_dir = PIPELINE.paper_intensive_images_dir(
            {"vault": vault}, task, create=True
        )
        unit_dir = image_dir / "U01"
        unit_dir.mkdir(parents=True)
        return source, extract, main_note, queue_file

    def test_log_uses_separate_directory_and_same_filename(self):
        task = self.make_task()
        self.assertEqual(
            task["paragraph_reading_note_path"],
            f"wiki/papers/close-reading/{Path(task['note_path']).name}",
        )

    def test_controls_are_added_without_overwriting_human_choices(self):
        with tempfile.TemporaryDirectory() as directory:
            note = Path(directory) / "paper.md"
            note.write_text(
                "---\ntype: paper\nparagraph_reading: true\n"
                "paragraph_reading_status: partial\n---\n\n# Paper\n",
                encoding="utf-8",
            )
            self.assertTrue(PIPELINE.ensure_paper_reading_controls(note))
            values = PIPELINE.yaml_frontmatter_scalars(note.read_text(encoding="utf-8"))
            self.assertTrue(PIPELINE.yaml_boolean(values["paragraph_reading"]))
            self.assertEqual(
                PIPELINE.unquote_yaml_scalar(values["paragraph_reading_status"]), "partial"
            )
            self.assertIn("paragraph_reading_figures", values)
            self.assertIn("paragraph_reading_note", values)

    def test_start_requires_human_checkbox(self):
        with tempfile.TemporaryDirectory() as directory:
            note = Path(directory) / "paper.md"
            note.write_text(
                "---\ntype: paper\nparagraph_reading: false\n"
                "paragraph_reading_figures: false\n---\n",
                encoding="utf-8",
            )
            with self.assertRaisesRegex(RuntimeError, "not checked"):
                PIPELINE.paragraph_reading_preferences(note)

    def test_paragraph_pair_log_validates_without_unneeded_visual_crop(self):
        with tempfile.TemporaryDirectory() as directory:
            vault = Path(directory)
            task = self.make_task()
            task["pdf_extractor_used"] = "mineru"
            PIPELINE.paper_intensive_images_dir({"vault": vault}, task, create=True)
            state = PIPELINE.validate_paragraph_reading_note(
                {"vault": vault}, task, self.make_log(task)
            )
            self.assertEqual(state["stage"], "awaiting_initial_analysis")
            self.assertEqual(state["covered_units"], 0)

    def test_log_rejects_mineru_or_other_non_pdf_visual_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            vault = Path(directory)
            task = self.make_task()
            task["pdf_extractor_used"] = "mineru"
            PIPELINE.paper_intensive_images_dir({"vault": vault}, task, create=True)
            foreign = Path(task["images_dir"]) / "mineru-figure.png"
            text = self.make_log(task, visual_path=foreign.as_posix())
            with self.assertRaisesRegex(RuntimeError, "visual crop must use"):
                PIPELINE.validate_paragraph_reading_note({"vault": vault}, task, text)

    def test_visual_crop_is_embedded_after_matching_translation(self):
        with tempfile.TemporaryDirectory() as directory:
            vault = Path(directory)
            task = self.make_task()
            task["pdf_extractor_used"] = "mineru"
            image_dir = PIPELINE.paper_intensive_images_dir(
                {"vault": vault}, task, create=True
            )
            unit_dir = image_dir / "U01"
            unit_dir.mkdir(parents=True)
            visual = f"{task['paragraph_reading_images_dir']}/U01/figure-p001-fig01.png"
            (unit_dir / "figure-p001-fig01.png").write_bytes(b"png")
            state = PIPELINE.validate_paragraph_reading_note(
                {"vault": vault}, task, self.make_log(task, visual_path=visual)
            )
            self.assertEqual(state["current_unit"], "U01")

    def test_log_rejects_old_separate_source_and_translation_blocks(self):
        with tempfile.TemporaryDirectory() as directory:
            vault = Path(directory)
            task = self.make_task()
            task["pdf_extractor_used"] = "mineru"
            PIPELINE.paper_intensive_images_dir({"vault": vault}, task, create=True)
            old_layout = self.make_log(task).replace(
                "#### 原文与翻译\n\n##### P01\n\nSource evidence paragraph.\n\n"
                "<!-- pair:P01:split -->\n\n来源证据段落。",
                "#### 原文\n\nSource evidence paragraph.\n\n"
                "#### 翻译\n\n来源证据段落。\n\n#### 配图\n\n本单元无独立配图。",
            )
            with self.assertRaisesRegex(RuntimeError, "missing #### 原文与翻译"):
                PIPELINE.validate_paragraph_reading_note({"vault": vault}, task, old_layout)

    def test_log_rejects_visible_source_and_translation_labels(self):
        with tempfile.TemporaryDirectory() as directory:
            vault = Path(directory)
            task = self.make_task()
            task["pdf_extractor_used"] = "mineru"
            PIPELINE.paper_intensive_images_dir({"vault": vault}, task, create=True)
            labeled = self.make_log(task).replace(
                "Source evidence paragraph.\n\n<!-- pair:P01:split -->\n\n来源证据段落。",
                "###### 原文\n\nSource evidence paragraph.\n\n"
                "<!-- pair:P01:split -->\n\n###### 翻译\n\n来源证据段落。",
            )
            with self.assertRaisesRegex(RuntimeError, "must not display 原文 or 翻译"):
                PIPELINE.validate_paragraph_reading_note({"vault": vault}, task, labeled)

    def test_source_paragraph_cannot_be_replaced_with_an_image(self):
        with tempfile.TemporaryDirectory() as directory:
            vault = Path(directory)
            task = self.make_task()
            task["pdf_extractor_used"] = "mineru"
            PIPELINE.paper_intensive_images_dir({"vault": vault}, task, create=True)
            source_crop = (
                f"{task['paragraph_reading_images_dir']}/U01/figure-p001-fig01.png"
            )
            text = self.make_log(task).replace(
                "Source evidence paragraph.",
                f"Source evidence paragraph.\n\n![[{source_crop}]]",
            )
            with self.assertRaisesRegex(RuntimeError, "source text cannot embed images"):
                PIPELINE.validate_paragraph_reading_note({"vault": vault}, task, text)

    def test_continue_creates_log_without_changing_primary_body(self):
        with tempfile.TemporaryDirectory() as directory:
            vault = Path(directory)
            task = self.make_task()
            _source, extract, main_note, queue_file = self.prepare_vault(vault, task)

            def fake_codex(*_args, **_kwargs):
                log_note = vault / task["paragraph_reading_note_path"]
                log_note.parent.mkdir(parents=True)
                log_note.write_text(self.make_log(task), encoding="utf-8")
                return subprocess.CompletedProcess([], 0, stdout="ok", stderr="")

            config = {"vault": vault, "paragraph_reading_timeout_seconds": 30}
            with mock.patch.object(
                PIPELINE,
                "ensure_paragraph_reading_skill",
                return_value="paper-intensive-reading",
            ), mock.patch.object(
                PIPELINE, "extract_pdf", return_value=extract
            ), mock.patch.object(
                PIPELINE, "codex_command", side_effect=fake_codex
            ):
                self.assertEqual(PIPELINE.paragraph_read_paper(config, task["note_path"]), 0)

            main_text = main_note.read_text(encoding="utf-8")
            self.assertIn("# Main\n\nOriginal body.", main_text)
            self.assertNotIn("Source evidence", main_text)
            main_values = PIPELINE.yaml_frontmatter_scalars(main_text)
            self.assertEqual(
                PIPELINE.unquote_yaml_scalar(main_values["paragraph_reading_status"]),
                "partial",
            )
            saved_task = json.loads(queue_file.read_text(encoding="utf-8"))["items"][0]
            self.assertEqual(saved_task["status"], "drafted")

    def test_initial_understanding_requires_explicit_nonempty_submission(self):
        task = self.make_task()
        empty = self.make_log(task)
        with self.assertRaisesRegex(RuntimeError, "尚未填写完成"):
            PIPELINE.validate_initial_understanding_submission(empty, "U01")
        filled = self.make_log(task, initial_answer="作者通过对照实验验证了关键机制。")
        block = PIPELINE.validate_initial_understanding_submission(filled, "U01")
        self.assertIn("对照实验", block)

    def test_continue_cannot_implicitly_submit_initial_understanding(self):
        with tempfile.TemporaryDirectory() as directory:
            vault = Path(directory)
            task = self.make_task()
            self.prepare_vault(vault, task)
            log_note = vault / task["paragraph_reading_note_path"]
            log_note.parent.mkdir(parents=True)
            log_note.write_text(
                self.make_log(task, initial_answer="我已经写完了初始理解。"),
                encoding="utf-8",
            )
            config = {"vault": vault, "paragraph_reading_timeout_seconds": 30}
            with mock.patch.object(
                PIPELINE,
                "ensure_paragraph_reading_skill",
                return_value="paper-intensive-reading",
            ):
                with self.assertRaisesRegex(RuntimeError, "点击.*提交初始理解"):
                    PIPELINE.paragraph_read_paper(config, task["note_path"], "continue")

    def test_continue_migrates_legacy_waiting_log_without_advancing(self):
        with tempfile.TemporaryDirectory() as directory:
            vault = Path(directory)
            task = self.make_task()
            _source, extract, _main_note, _queue_file = self.prepare_vault(vault, task)
            log_note = vault / task["paragraph_reading_note_path"]
            log_note.parent.mkdir(parents=True)
            legacy = self.make_log(task).replace(
                "workflow: full-text-unlabeled-paragraph-pairs",
                "workflow: full-text-reasoning-units",
            )
            log_note.write_text(legacy, encoding="utf-8")
            seen_prompts = []

            def fake_codex(_config, prompt, *_args, **_kwargs):
                seen_prompts.append(prompt)
                log_note.write_text(self.make_log(task), encoding="utf-8")
                return subprocess.CompletedProcess([], 0, stdout="ok", stderr="")

            config = {"vault": vault, "paragraph_reading_timeout_seconds": 30}
            with mock.patch.object(
                PIPELINE,
                "ensure_paragraph_reading_skill",
                return_value="paper-intensive-reading",
            ), mock.patch.object(
                PIPELINE, "extract_pdf", return_value=extract
            ), mock.patch.object(
                PIPELINE, "codex_command", side_effect=fake_codex
            ):
                self.assertEqual(
                    PIPELINE.paragraph_read_paper(config, task["note_path"], "continue"),
                    0,
                )

            self.assertIn('"intensive_reading_migration_only": true', seen_prompts[0])
            state = PIPELINE.parse_intensive_reading_state(
                log_note.read_text(encoding="utf-8")
            )
            self.assertEqual(state["stage"], "awaiting_initial_analysis")

    def test_submit_rejects_legacy_log_until_display_migration(self):
        with tempfile.TemporaryDirectory() as directory:
            vault = Path(directory)
            task = self.make_task()
            self.prepare_vault(vault, task)
            log_note = vault / task["paragraph_reading_note_path"]
            log_note.parent.mkdir(parents=True)
            legacy = self.make_log(
                task, initial_answer="我已经完成了旧版初始理解。"
            ).replace(
                "workflow: full-text-unlabeled-paragraph-pairs",
                "workflow: full-text-reasoning-units",
            )
            log_note.write_text(legacy, encoding="utf-8")
            config = {"vault": vault, "paragraph_reading_timeout_seconds": 30}
            with mock.patch.object(
                PIPELINE,
                "ensure_paragraph_reading_skill",
                return_value="paper-intensive-reading",
            ):
                with self.assertRaisesRegex(RuntimeError, "旧版格式"):
                    PIPELINE.paragraph_read_paper(
                        config, task["note_path"], "submit-initial"
                    )

    def test_submit_initial_advances_only_after_explicit_action(self):
        with tempfile.TemporaryDirectory() as directory:
            vault = Path(directory)
            task = self.make_task()
            _source, extract, main_note, _queue_file = self.prepare_vault(vault, task)
            log_note = vault / task["paragraph_reading_note_path"]
            log_note.parent.mkdir(parents=True)
            answer = "作者先建立结构差异，再用实验结果验证机制。"
            log_note.write_text(
                self.make_log(task, initial_answer=answer), encoding="utf-8"
            )
            seen_prompts = []

            def fake_codex(_config, prompt, *_args, **_kwargs):
                seen_prompts.append(prompt)
                log_note.write_text(
                    self.make_log(
                        task,
                        stage="awaiting_supervisor_answer",
                        initial_answer=answer,
                    ),
                    encoding="utf-8",
                )
                return subprocess.CompletedProcess([], 0, stdout="ok", stderr="")

            config = {"vault": vault, "paragraph_reading_timeout_seconds": 30}
            with mock.patch.object(
                PIPELINE,
                "ensure_paragraph_reading_skill",
                return_value="paper-intensive-reading",
            ), mock.patch.object(
                PIPELINE, "extract_pdf", return_value=extract
            ), mock.patch.object(
                PIPELINE, "codex_command", side_effect=fake_codex
            ):
                self.assertEqual(
                    PIPELINE.paragraph_read_paper(
                        config, task["note_path"], "submit-initial"
                    ),
                    0,
                )

            self.assertIn('"intensive_reading_action": "submit-initial"', seen_prompts[0])
            self.assertIn(answer, log_note.read_text(encoding="utf-8"))
            self.assertIn("Original body.", main_note.read_text(encoding="utf-8"))

    def test_log_resolves_back_to_primary_note(self):
        with tempfile.TemporaryDirectory() as directory:
            vault = Path(directory)
            task = self.make_task()
            self.prepare_vault(vault, task)
            log_note = vault / task["paragraph_reading_note_path"]
            log_note.parent.mkdir(parents=True)
            log_note.write_text(
                self.make_log({**task, "pdf_extractor_used": "mineru"}), encoding="utf-8"
            )
            primary, relative = PIPELINE.resolve_primary_paper_note(
                {"vault": vault}, task["paragraph_reading_note_path"]
            )
            self.assertEqual(relative, task["note_path"])
            self.assertEqual(primary, (vault / task["note_path"]).resolve())

    def test_merge_is_the_only_stage_that_adds_verified_increment(self):
        with tempfile.TemporaryDirectory() as directory:
            vault = Path(directory)
            task = self.make_task()
            _source, extract, main_note, queue_file = self.prepare_vault(vault, task)
            ready_task = {**task, "pdf_extractor_used": "mineru"}
            log_note = vault / task["paragraph_reading_note_path"]
            log_note.parent.mkdir(parents=True)
            log_note.write_text(
                self.make_log(
                    ready_task,
                    stage="ready_to_merge",
                    score=7,
                    verified_units="U01",
                ),
                encoding="utf-8",
            )

            def fake_codex(*_args, **_kwargs):
                main_text = main_note.read_text(encoding="utf-8")
                main_note.write_text(
                    main_text
                    + "\n## 精读验证与增量\n\n"
                    "<!-- intensive-reading:U01:start -->\n"
                    "### U01 · Claim\n\n"
                    "- 验证结论：Verified\n"
                    "- 对原自动笔记的处理：已补充\n"
                    "- 非重复增量：New boundary\n"
                    "- 证据与边界：Evidence "
                    "[[sources/literature/pdf/paper.pdf#page=1|PDF p.1]]\n"
                    "<!-- intensive-reading:U01:end -->\n",
                    encoding="utf-8",
                )
                log_note.write_text(
                    self.make_log(
                        ready_task,
                        stage="ready_for_next_unit",
                        covered=1,
                        total=2,
                        score=7,
                        verified_units="U01",
                        merged_units="U01",
                    ),
                    encoding="utf-8",
                )
                return subprocess.CompletedProcess([], 0, stdout="ok", stderr="")

            config = {"vault": vault, "paragraph_reading_timeout_seconds": 30}
            with mock.patch.object(
                PIPELINE,
                "ensure_paragraph_reading_skill",
                return_value="paper-intensive-reading",
            ), mock.patch.object(
                PIPELINE, "extract_pdf", return_value=extract
            ), mock.patch.object(
                PIPELINE, "codex_command", side_effect=fake_codex
            ):
                self.assertEqual(PIPELINE.paragraph_merge_paper(config, task["note_path"]), 0)

            main_text = main_note.read_text(encoding="utf-8")
            self.assertEqual(main_text.count("<!-- intensive-reading:U01:start -->"), 1)
            values = PIPELINE.yaml_frontmatter_scalars(main_text)
            self.assertEqual(
                PIPELINE.unquote_yaml_scalar(values["intensive_reading_coverage"]),
                "1/2 (50%)",
            )
            self.assertFalse(PIPELINE.yaml_boolean(values["intensive_reading_verified"]))
            self.assertEqual(
                PIPELINE.unquote_yaml_scalar(values["knowledge_growth_status"]),
                "not_ready",
            )
            saved_task = json.loads(queue_file.read_text(encoding="utf-8"))["items"][0]
            self.assertEqual(saved_task["status"], "drafted")

    def test_auxiliary_log_cannot_be_integrated_directly(self):
        with tempfile.TemporaryDirectory() as directory:
            vault = Path(directory)
            log_note = vault / "wiki/papers/close-reading/paper.md"
            log_note.parent.mkdir(parents=True)
            log_note.write_text(
                "---\ntype: paper-intensive-reading-log\nstatus: reviewed\n---\n",
                encoding="utf-8",
            )
            with self.assertRaisesRegex(RuntimeError, "auxiliary"):
                PIPELINE.integrate_note({"vault": vault}, "wiki/papers/close-reading/paper.md")

    def test_redraft_requeues_only_the_exact_existing_paper_note(self):
        with tempfile.TemporaryDirectory() as directory:
            vault = Path(directory)
            task = self.make_task()
            note = vault / task["note_path"]
            note.parent.mkdir(parents=True)
            note.write_text("---\ntype: paper\nstatus: draft\n---\n", encoding="utf-8")
            queue_file = vault / "system/queue/pending.json"
            queue_file.parent.mkdir(parents=True)
            queue_file.write_text(
                json.dumps({"schema_version": 1, "items": [task]}), encoding="utf-8"
            )
            self.assertEqual(PIPELINE.queue_paper_redraft({"vault": vault}, task["note_path"]), 0)
            saved_task = json.loads(queue_file.read_text(encoding="utf-8"))["items"][0]
            self.assertEqual(saved_task["status"], "pending")
            self.assertEqual(saved_task["redraft_previous_status"], "drafted")

    def test_paper_ingest_and_redraft_use_thirty_minute_limits(self):
        config = {"codex_timeout_seconds": 1800, "redraft_timeout_seconds": 1800}
        self.assertEqual(
            PIPELINE.ingest_timeout_seconds(
                config, {"kind": "paper", "redraft_requested_at": "2026-09-02T18:00:00+08:00"}
            ),
            1800,
        )
        self.assertEqual(PIPELINE.ingest_timeout_seconds(config, {"kind": "paper"}), 1800)

    def test_forge_runtime_persists_checkpoint_and_exposes_previous_plan_for_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            vault = Path(directory)
            config = {"vault": vault}
            task = self.make_task()
            task["sha256"] = "0" * 64
            first = PIPELINE.prepare_forge_runtime(config, task, 1800)
            first_plan = vault / first["forge_note_plan_path"]
            first_plan.write_text('{"source_id":"same"}', encoding="utf-8")
            second = PIPELINE.prepare_forge_runtime(config, task, 1800)
            self.assertEqual(second["forge_resume_plan_path"], first["forge_note_plan_path"])
            checkpoint = json.loads(
                (vault / second["forge_checkpoint_path"]).read_text(encoding="utf-8")
            )
            self.assertEqual(checkpoint["stage"], "generation_pending")
            self.assertEqual(checkpoint["source_sha256"], task["sha256"])

    def test_timeout_log_keeps_partial_output_without_serializing_prompt(self):
        with tempfile.TemporaryDirectory() as directory:
            vault = Path(directory)
            error = subprocess.TimeoutExpired(
                cmd=["codex", "SECRETLY-LONG-PROMPT"],
                timeout=25,
                output=b"partial progress",
                stderr=b"partial error",
            )
            path = PIPELINE.write_timeout_run_log(
                {"vault": vault}, "ingest", "paper:test", "generation", error
            )
            text = path.read_text(encoding="utf-8")
            self.assertIn("timed_out=true", text)
            self.assertIn("partial progress", text)
            self.assertNotIn("SECRETLY-LONG-PROMPT", text)

    def test_deterministic_forge_validation_combines_all_required_gates(self):
        with tempfile.TemporaryDirectory() as directory:
            vault = Path(directory)
            config = {"vault": vault, "forge_python_path": sys.executable}
            task = self.make_task()
            task["sha256"] = "0" * 64
            PIPELINE.prepare_forge_runtime(config, task, 1800)
            note = vault / task["note_path"]
            note.parent.mkdir(parents=True)
            note.write_text("# Draft\n", encoding="utf-8")
            completed = subprocess.CompletedProcess([], 0, stdout="{}", stderr="")
            note_report = {
                name: True
                for name in (
                    "passes_basic_structure",
                    "passes_style_gate",
                    "passes_math_gate",
                    "passes_figure_gate",
                    "passes_reference_hygiene_gate",
                    "passes_plan_gate",
                    "passes_substantive_content",
                    "passes_table_gate",
                )
            }
            reports = [
                ({"changed": False}, completed),
                (note_report, completed),
                ({"passes_research_audit": True}, completed),
                ({"passed": True}, completed),
            ]
            with mock.patch.object(PIPELINE, "run_forge_script", side_effect=reports):
                validation = PIPELINE.validate_forge_draft(
                    config, task, note, time.monotonic() + 30
                )
            self.assertTrue(validation["passed"])
            self.assertEqual(validation["status"], "passed")
            self.assertTrue((vault / task["forge_validation_path"]).is_file())

    def test_runner_replaces_paper_draft_index_entry_without_duplicates(self):
        with tempfile.TemporaryDirectory() as directory:
            vault = Path(directory)
            task = self.make_task()
            index = vault / "wiki/index.md"
            index.parent.mkdir(parents=True)
            index.write_text(
                "# Index\n\n## 待审核草稿\n\n"
                "<!-- runner -->\n\n"
                f"- [[{task['note_path']}|Old title]] — old\n\n"
                "## 已整合来源\n",
                encoding="utf-8",
            )
            self.assertTrue(PIPELINE.ensure_paper_draft_index_entry({"vault": vault}, task))
            updated = index.read_text(encoding="utf-8")
            target = task["note_path"].removesuffix(".md")
            self.assertEqual(updated.count(f"[[{target}|{task['display_title']}]]"), 1)
            self.assertNotIn("Old title", updated)
            self.assertFalse(PIPELINE.ensure_paper_draft_index_entry({"vault": vault}, task))

    def test_cancel_redrafts_restores_previous_states(self):
        with tempfile.TemporaryDirectory() as directory:
            vault = Path(directory)
            queue_file = vault / "system/queue/pending.json"
            queue_file.parent.mkdir(parents=True)
            queue_file.write_text(
                json.dumps(
                    {
                        "schema_version": 1,
                        "items": [
                            {
                                "id": "paper:a",
                                "status": "pending",
                                "redraft_previous_status": "drafted",
                                "redraft_requested_at": "now",
                            },
                            {
                                "id": "paper:b",
                                "status": "failed",
                                "last_error": "timeout",
                                "redraft_previous_status": "integrated",
                                "redraft_requested_at": "now",
                            },
                        ],
                    }
                ),
                encoding="utf-8",
            )
            self.assertEqual(PIPELINE.cancel_paper_redrafts({"vault": vault}), 2)
            items = json.loads(queue_file.read_text(encoding="utf-8"))["items"]
            self.assertEqual([item["status"] for item in items], ["drafted", "integrated"])
            self.assertTrue(all("redraft_requested_at" not in item for item in items))
            self.assertTrue(all("last_error" not in item for item in items))


if __name__ == "__main__":
    unittest.main()
