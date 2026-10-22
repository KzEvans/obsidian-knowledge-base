# Third-party notices

## Runtime dependencies

- [yaml](https://github.com/eemeli/yaml) — ISC. Parses model-provided frontmatter lists. License:

```text
Copyright Eemeli Aro <eemeli@gmail.com>

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
```

- [fflate](https://github.com/101arrowz/fflate) — MIT. Unzips MinerU result archives.

## Services

- MinerU cloud precision API (VLM model) parses PDFs. Only PDFs in the library, or ones you confirm, are uploaded.
- Alibaba Cloud Model Studio Qwen-MT translates paragraphs and selections.

## Archived code

`legacy/` keeps the replaced plugins and skills unchanged, including their own
notices: `legacy/knowledge-base-repo/THIRD_PARTY_NOTICES.md` (LLM Wiki adaptation,
DeepPaperNote, PaperForge, paper-reading-skill). That code is not built into the plugin.

## Note-writing guidance

`skills/paper-note/references/plain-writing.md` (the "说人话" rules) is an original summary,
written for paper notes, of ideas from [Humanizer-zh](https://github.com/op7418/Humanizer-zh)
by 歸藏 (op7418), commit `f4518a8eab97b8bfebc66a89d34320a89bef6930` (2026-09-23), MIT License,
Copyright (c) 2026 歸藏. No text is copied; the examples are new. Humanizer-zh credits
blader/humanizer, hardikpandya/stop-slop and Wikipedia's "Signs of AI writing" as its own sources.
