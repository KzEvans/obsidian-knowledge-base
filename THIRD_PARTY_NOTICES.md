# Third-party notices and citations

This repository vendors the three Codex skills used by the knowledge pipeline.

## DeepPaperNote

`skills/forge-paper-note/` reuses the deterministic single-paper pipeline and
Obsidian/figure conventions from
[917Dhj/DeepPaperNote](https://github.com/917Dhj/DeepPaperNote), commit
`098cd724eb7b744b9b8dff94140188858e77ab07`. Those portions are distributed under
the upstream MIT license preserved at
`skills/forge-paper-note/LICENSE.DeepPaperNote`.

```bibtex
@software{deeppapernote,
  author  = {{917Dhj}},
  title   = {DeepPaperNote},
  url     = {https://github.com/917Dhj/DeepPaperNote},
  version = {098cd724eb7b744b9b8dff94140188858e77ab07}
}
```

## PaperForge

The independently written research-audit instructions in `skills/forge-paper-note/`
were informed by the research-reasoning approach in
[FeijiangHan/PaperForge](https://github.com/FeijiangHan/PaperForge), commit
`68addabc0d425b9dd358eaf604e5806e930ad3a2`. No PaperForge code or prose is vendored:
the inspected revision did not expose a license file.

```bibtex
@software{han_paperforge,
  author  = {Feijiang Han},
  title   = {PaperForge},
  url     = {https://github.com/FeijiangHan/PaperForge},
  version = {68addabc0d425b9dd358eaf604e5806e930ad3a2}
}
```

## Paper Reading Skill

`skills/paper-reading/` is vendored from
[Kingslayer-bot/paper-reading-skill](https://github.com/Kingslayer-bot/paper-reading-skill),
commit `0753224cd94bc0bd923c111584c2326cdf18d1de`, for the optional Mode A workflow.
It is distributed under the upstream MIT license preserved at
`skills/paper-reading/LICENSE`.

```bibtex
@software{paper_reading_skill,
  author  = {{Kingslayer-bot}},
  title   = {Paper Reading Skill},
  url     = {https://github.com/Kingslayer-bot/paper-reading-skill},
  version = {0753224cd94bc0bd923c111584c2326cdf18d1de}
}
```

`skills/paper-intensive-reading/` is a project-specific adaptation of that Mode A
workflow. It changes the unit of analysis to continuous, non-overlapping reasoning
units; adds user reconstruction, scoring, an auxiliary verification log, MinerU
evidence routing, and an explicit verified-unit merge gate. The original vendored
`skills/paper-reading/` remains unchanged. The adaptation is distributed under the
same MIT license, preserved at `skills/paper-intensive-reading/LICENSE`.
