import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { ReaderBlock } from "../../src/core/types";
import type * as Render from "../../src/reader/render";
import type { ReaderRenderOptions, RenderBlock } from "../../src/reader/render";
import { dom, harness, load, rectangle } from "./harness";

// Ported from legacy/pdf-reading-mode/tests/render.test.ts; behaviour is unchanged.
const renderer = load<typeof Render>("src/reader/render.ts");

async function render(
  blocks: RenderBlock[], invalidFormula?: string, extraOptions: Partial<ReaderRenderOptions> = {},
  beforeRender?: (root: HTMLElement) => void,
) {
  const { document } = dom({ invalidFormula });
  const root = document.body.createDiv();
  beforeRender?.(root);
  const options: ReaderRenderOptions = { fontSize: 18, lineHeight: 1.5, assetUrl: () => "", onSource: () => {}, onCopy: () => {}, onZoom: () => {}, ...extraOptions };
  await (await renderer).renderReader(root, blocks, options);
  return { root, harness: harness() };
}

function block(id: string, kind: ReaderBlock["kind"], text: string, extra: Partial<ReaderBlock> = {}): ReaderBlock {
  return { id, kind, text, sources: [{ page: 1 }], ...extra };
}

test("cold-start rendering waits for MathJax before both block and inline formulas", async () => {
  const { root, harness } = await render([
    block("equation", "equation", "$$S_z = -p/Y$$"),
    block("body", "paragraph", "The field is $E=U/d$."),
  ]);
  assert.deepEqual(harness.calls, ["load:start", "load:ready", "math:S_z = -p/Y", "math:E=U/d", "flush"]);
  assert.equal(root.querySelectorAll(".test-math").length, 2);
  assert.equal(root.querySelectorAll(".pdf-reader-math-fallback").length, 0);
});

test("reopening a rendered paper reuses finished formulas without another MathJax flush", async () => {
  const blocks = [block("body", "paragraph", "The field is $E=U/d$.")];
  const { root, harness: math } = await render(blocks);
  const first = root.querySelector(".test-math")!;
  math.calls.length = 0;
  await (await renderer).renderReader(root, blocks, {
    fontSize: 18, lineHeight: 1.5, assetUrl: () => "", onSource: () => {}, onCopy: () => {}, onZoom: () => {},
  });
  const reopened = root.querySelector<HTMLElement>(".test-math")!;
  assert.equal(reopened.dataset.source, "E=U/d");
  assert.notEqual(reopened, first);
  assert.equal(math.calls.filter(call => call.startsWith("math:")).length, 0);
  assert.equal(math.calls.includes("flush"), false);
});

test("repeated formulas keep independent nodes and distinct inline/display layouts", async () => {
  const { root, harness: math } = await render([
    block("body", "paragraph", "$x=1$ and $x=1$."),
    block("equation", "equation", "$$x=1$$"),
  ]);
  assert.equal(root.querySelectorAll(".test-math").length, 3);
  assert.equal(root.querySelectorAll(".pdf-reader-inline-math").length, 2);
  assert.equal(root.querySelectorAll(".pdf-reader-display-math").length, 1);
  assert.equal(math.calls.filter(call => call.startsWith("math:")).length, 2);
});

test("a failed MathJax stylesheet flush is retried when the paper reopens", async () => {
  const { document } = dom({ failFlush: true });
  const root = document.body.createDiv();
  const options: ReaderRenderOptions = { fontSize: 18, lineHeight: 1.5, assetUrl: () => "", onSource: () => {}, onCopy: () => {}, onZoom: () => {} };
  const blocks = [block("body", "paragraph", "$x=1$.")];
  const api = await renderer;
  await api.renderReader(root, blocks, options);
  assert.equal(root.querySelectorAll(".pdf-reader-render-notice").length, 1);
  harness().failFlush = false;
  harness().calls.length = 0;
  await api.renderReader(root, blocks, options);
  assert.equal(root.querySelectorAll(".test-math").length, 1);
  assert.equal(root.querySelectorAll(".pdf-reader-render-notice").length, 0);
  assert.equal(harness().calls.includes("flush"), true);
});

test("cached numbered formulas get independent IDs and preserve their local references", async () => {
  const { document } = dom({ mathIds: true });
  const root = document.body.createDiv();
  await (await renderer).renderReader(root, [block("body", "paragraph", "$x=1$ and $x=1$.")], {
    fontSize: 18, lineHeight: 1.5, assetUrl: () => "", onSource: () => {}, onCopy: () => {}, onZoom: () => {},
  });
  const formulas = Array.from(root.querySelectorAll<HTMLElement>(".test-math"));
  assert.equal(formulas.length, 2);
  assert.notEqual(formulas[0]!.id, formulas[1]!.id);
  for (const formula of formulas) {
    assert.equal(formula.querySelector("a")!.getAttribute("href"), `#${formula.id}`);
    const glyph = formula.querySelector("path")!;
    const use = formula.querySelector("use")!;
    assert.equal(use.getAttribute("xlink:href"), `#${glyph.id}`);
    assert.equal(use.getAttribute("clip-path"), `url(#${glyph.id})`);
    assert.equal(formula.getAttribute("aria-labelledby"), glyph.id);
  }
  assert.equal(harness().calls.filter(call => call.startsWith("math:")).length, 1);
});

test("named equation labels and references retain MathJax registration on each render", async () => {
  const { root, harness: math } = await render([
    block("body", "paragraph", "$x=1\\label{eq:x}$ and $x=1\\label{eq:x}$."),
    block("reference", "paragraph", "$\\eqref{eq:x}$ and $\\eqref{eq:x}$."),
  ]);
  assert.equal(root.querySelectorAll(".test-math").length, 4);
  assert.equal(math.calls.filter(call => call.startsWith("math:")).length, 4);
});

test("scientific tags in text, captions and footnotes coexist with comparisons and TeX", async () => {
  const { root } = await render([
    block("body", "paragraph", "ZrO<sub>2</sub> has units m<sup>3</sup>; $x < y & z$ and 2 < 3."),
    block("figure", "figure", "", { captions: ["Fig. 4. (SEHAS)<sub>2</sub> at $T=20$."], footnotes: ["<sup>a</sup> Measured value."] }),
  ]);
  assert.equal(root.querySelector(".pdf-reader-paragraph sub")?.textContent, "2");
  assert.equal(root.querySelector(".pdf-reader-paragraph sup")?.textContent, "3");
  assert.equal(root.querySelector("figcaption sub")?.textContent, "2");
  assert.equal(root.querySelector(".pdf-reader-figure-footnotes sup")?.textContent, "a");
  assert.equal(root.querySelector<HTMLElement>(".pdf-reader-paragraph .test-math")?.dataset.source, "x < y & z");
  assert.ok(root.textContent?.includes("2 < 3"));
  assert.ok(!root.textContent?.includes("<sub>"));
});

test("native-text HTML entities are decoded once without becoming executable markup", async () => {
  const { root } = await render([
    block("native", "paragraph", "ε₀ &lt; μ &amp; m<sup>3</sup> &lt;img src=x onerror=run()&gt;"),
  ]);
  assert.ok(root.textContent?.includes("ε₀ < μ & m3 <img src=x onerror=run()>"));
  assert.equal(root.querySelectorAll("img").length, 0);
  assert.equal(root.querySelector("sup")?.textContent, "3");
});

test("inline markup keeps superscripts while stripping handlers and active links", async () => {
  const { root } = await render([
    block("unsafe", "paragraph", '<sup onclick="run()" style="color:red">3</sup> <a href="javascript:run()">value</a> $x < y$'),
    block("table", "table", "", { html: '<table><tr><td onclick="run()"><img src="https://invalid.test/remote.png">cell</td></tr></table>' }),
  ]);
  assert.equal(root.querySelector("sup")?.textContent, "3");
  assert.equal(root.querySelectorAll("[onclick], [style], a[href], img[src], script").length, 0);
  assert.equal(root.querySelector("td"), null);
  assert.equal(root.querySelector<HTMLElement>(".test-math")?.dataset.source, "x < y");
});

test("malformed scientific formulas remain verbatim with a source-page control", async () => {
  const invalid = "T_{g}^{a)/°C";
  const { root } = await render([block("bad", "paragraph", `Temperature $${invalid}$.`)], invalid);
  assert.equal(root.querySelector(".pdf-reader-math-fallback")?.textContent, invalid);
  assert.ok(root.querySelector(".has-math-fallback .pdf-reader-block-tools button"));
  assert.equal(root.querySelectorAll("mjx-merror").length, 0);
});

test("tables always use the local original-PDF crop with selectable captions and scientific footnotes", async () => {
  const zoomCaptions: string[] = [];
  const { root } = await render([
    block("table", "table", "Cloud OCR cell data", { asset: "fallback/table.png", html: "<table><tr><td>Reconstructed cell</td><td>$E=U/d$</td></tr></table>", captions: ["Table 3. Original measurements."], footnotes: ["<sup>a</sup> Measured at $T=20$."] }),
  ], undefined, { assetUrl: () => "app://local/fallback/table.png", onZoom: (_url, caption) => zoomCaptions.push(caption) });
  const original = root.querySelector('[data-reader-block-id="table"]')!;
  const image = original.querySelector<HTMLImageElement>("img")!;
  assert.equal(image.getAttribute("src"), "app://local/fallback/table.png");
  assert.equal(original.querySelector("table"), null);
  assert.ok(!original.textContent?.includes("Reconstructed cell"));
  assert.ok(!original.textContent?.includes("Cloud OCR cell data"));
  assert.equal(original.querySelector(".pdf-reader-math-fallback"), null);
  assert.equal(original.querySelector("figcaption")?.textContent, "Table 3. Original measurements.");
  assert.equal(original.querySelector(".pdf-reader-figure-footnotes sup")?.textContent, "a");
  assert.equal(original.querySelector<HTMLElement>(".pdf-reader-figure-footnotes .test-math")?.dataset.source, "T=20");
  assert.ok(original.querySelector(".pdf-reader-block-tools button"));
  image.dispatchEvent(new root.ownerDocument.defaultView!.Event("click"));
  assert.deepEqual(zoomCaptions, ["Table 3. Original measurements."]);
});

test("a missing table source crop prompts the source page instead of rendering provider HTML", async () => {
  const { root } = await render([
    block("table", "table", "Cloud OCR cell data", { html: "<table><tr><td>Reconstructed cell</td></tr></table>", captions: ["Table 1. Caption kept."] }),
  ]);
  assert.equal(root.querySelector("table"), null);
  assert.equal(root.querySelector("img"), null);
  assert.ok(root.querySelector(".pdf-reader-render-notice")?.textContent?.includes("查看源页"));
  assert.ok(!root.textContent?.includes("Reconstructed cell"));
  assert.ok(!root.textContent?.includes("Cloud OCR cell data"));
  assert.equal(root.querySelector("figcaption")?.textContent, "Table 1. Caption kept.");
  assert.ok(root.querySelector(".pdf-reader-block-tools button"));
});

test("ancillary folds move to section ends without changing body or figure order", async () => {
  const { root } = await render([
    block("heading-1", "heading", "Introduction"),
    block("body-1", "paragraph", "First paragraph."),
    block("header", "header", "Journal header"),
    block("body-2", "paragraph", "Second paragraph."),
    block("figure", "figure", "panel OCR", { captions: ["Fig. 1. Scientific caption."] }),
    block("metadata", "metadata", "Publisher information"),
    block("body-3", "paragraph", "Third paragraph."),
    block("heading-2", "heading", "Results"),
    block("body-4", "paragraph", "Result paragraph."),
    block("footer", "footer", "Last-page footer"),
  ]);
  const article = root.querySelector("article")!;
  const direct = Array.from(article.children).map((element) => (element as HTMLElement).dataset.readerBlockId ?? (element as HTMLElement).dataset.foldKind);
  assert.deepEqual(direct, ["heading-1", "body-1", "body-2", "figure", "body-3", "page-furniture", "metadata", "heading-2", "body-4", "page-furniture"]);
  assert.equal(root.querySelector('[data-reader-block-id="header"]')?.closest("details")?.nextElementSibling?.getAttribute("data-fold-kind"), "metadata");
  assert.equal(root.querySelector('[data-reader-block-id="metadata"]')?.closest("details")?.nextElementSibling?.getAttribute("data-reader-block-id"), "heading-2");
});

test("references coalesce across page headers while staying after the body", async () => {
  const { root } = await render([
    block("body", "paragraph", "Last body paragraph."),
    block("references-heading", "heading", "References"),
    block("reference-1", "references", "[1] First source."),
    block("header", "header", "Repeated journal header", { sources: [{ page: 2 }] }),
    block("reference-2", "references", "[2] Second source.", { sources: [{ page: 2 }] }),
    block("footer", "footer", "Page 2", { sources: [{ page: 2 }] }),
  ]);
  const references = root.querySelectorAll('details[data-fold-kind="references"]');
  assert.equal(references.length, 1);
  assert.deepEqual(Array.from(references[0]!.querySelectorAll<HTMLElement>("[data-reader-block-id]")).map((element) => element.dataset.readerBlockId), ["references-heading", "reference-1", "reference-2"]);
  assert.equal(references[0]!.previousElementSibling?.getAttribute("data-fold-kind"), "page-furniture");
  assert.equal(references[0]!.previousElementSibling?.previousElementSibling?.getAttribute("data-reader-block-id"), "body");
  assert.equal(references[0]!.nextElementSibling, null);
  assert.equal(root.querySelector('[data-reader-block-id="header"]')?.closest("details")?.getAttribute("data-fold-kind"), "page-furniture");
  const geometry = { top: 0, left: 0, right: 500, bottom: 500, width: 500, height: 500, x: 0, y: 0, toJSON: () => ({}) };
  root.getBoundingClientRect = () => geometry;
  for (const element of Array.from(root.querySelectorAll<HTMLElement>(".pdf-reader-block"))) element.getBoundingClientRect = () => geometry;
  (await renderer).scrollToSourcePage(root, 2);
  assert.equal((references[0] as HTMLDetailsElement).open, true);
  assert.ok(!(root.querySelector('details[data-fold-kind="page-furniture"]') as HTMLDetailsElement).open);
});

test("a page link prioritizes that page's body over an earlier paragraph spanning both pages", async () => {
  const { root } = await render([
    block("continued", "paragraph", "A long paragraph begins on page one.", { sources: [{ page: 1 }, { page: 2 }] }),
    block("page-two", "paragraph", "The next paragraph starts on page two.", { sources: [{ page: 2 }] }),
  ]);
  const rectangle = (top: number) => ({ top, left: 0, right: 500, bottom: top + 80, width: 500, height: 80, x: 0, y: top, toJSON: () => ({}) });
  root.scrollTop = 0;
  root.getBoundingClientRect = () => rectangle(0);
  root.querySelector<HTMLElement>('[data-reader-block-id="continued"]')!.getBoundingClientRect = () => rectangle(100);
  root.querySelector<HTMLElement>('[data-reader-block-id="page-two"]')!.getBoundingClientRect = () => rectangle(200);
  (await renderer).scrollToSourcePage(root, 2);
  assert.equal(root.scrollTop, 176);
});

test("figure OCR text is omitted while real captions, footnotes and numbered caption fallback remain", async () => {
  const zoomCaptions: string[] = [];
  const { root } = await render([
    block("figure-ocr", "figure", "(a) (b) SEHAS random axis labels", { asset: "diagram.png", captions: ["Fig. 1. Network structure."], footnotes: ["Measured at room temperature."] }),
    block("figure-empty", "figure", "(c) stray graphic OCR"),
    block("figure-caption", "figure", "Figure 2. Schematic network."),
  ], undefined, { assetUrl: () => "app://local/diagram.png", onZoom: (_url, caption) => zoomCaptions.push(caption) });
  assert.ok(!root.textContent?.includes("random axis labels"));
  assert.ok(!root.textContent?.includes("stray graphic OCR"));
  assert.equal(root.querySelectorAll("figcaption").length, 2);
  assert.ok(root.textContent?.includes("Fig. 1. Network structure."));
  assert.ok(root.textContent?.includes("Measured at room temperature."));
  assert.equal(root.querySelector('[data-reader-block-id="figure-caption"] figcaption')?.textContent, "Figure 2. Schematic network.");
  const image = root.querySelector<HTMLImageElement>("img")!;
  assert.ok(image.alt.includes("random axis labels"));
  image.dispatchEvent(new root.ownerDocument.defaultView!.Event("click"));
  assert.deepEqual(zoomCaptions, ["Fig. 1. Network structure."]);
});

test("lazy figure and equation images reserve supplied dimensions without decoding", async () => {
  let decodes = 0;
  let imageProto: object | undefined;
  const dimensionsRequested: string[] = [];
  const { root } = await render([
    block("figure", "figure", "", { asset: "figure.png" }),
    block("equation", "equation", "$$invalid$$", { asset: "equation.png" }),
  ], "invalid", {
    assetUrl: reference => `app://local/${reference}`,
    assetDimensions: reference => { dimensionsRequested.push(reference); return { width: 900, height: 450 }; },
  }, root => {
    imageProto = Object.getPrototypeOf(root.createEl("img")) as object;
    root.empty();
    Object.defineProperty(imageProto, "decode", { value: () => { decodes++; return new Promise(() => {}); }, configurable: true, writable: true });
  });
  Reflect.deleteProperty(imageProto!, "decode");
  assert.equal(decodes, 0);
  assert.deepEqual(dimensionsRequested, ["figure.png", "equation.png"]);
  for (const image of Array.from(root.querySelectorAll<HTMLImageElement>("img"))) {
    assert.equal(image.loading, "lazy");
    assert.equal(image.getAttribute("width"), "900");
    assert.equal(image.getAttribute("height"), "450");
    assert.equal(image.style.aspectRatio, "900 / 450");
    assert.equal(image.dataset.readerLayoutReserved, "true");
  }
});

test("an image with no header dimensions learns its natural ratio on load", async () => {
  const { root } = await render([block("figure", "figure", "", { asset: "figure.png" })], undefined, {
    assetUrl: () => "app://local/figure.png",
  });
  const image = root.querySelector<HTMLImageElement>("img")!;
  assert.equal(image.getAttribute("width"), null);
  Object.defineProperties(image, { naturalWidth: { value: 640 }, naturalHeight: { value: 320 } });
  image.dispatchEvent(new root.ownerDocument.defaultView!.Event("load"));
  assert.equal(image.getAttribute("width"), "640");
  assert.equal(image.getAttribute("height"), "320");
  assert.equal(image.style.aspectRatio, "640 / 320");
  assert.notEqual(image.dataset.readerLayoutReserved, "true");
});

test("text-only documents do not wait for MathJax", async () => {
  const { harness } = await render([block("body", "paragraph", "A paragraph without formulas.")]);
  assert.deepEqual(harness.calls, []);
});

test("long rendering yields with partial DOM while keeping every formula and source block", async () => {
  let partialBlocks = -1;
  const blocks = Array.from({ length: 125 }, (_, index) => block(`body-${index}`, "paragraph", `Formula $x_${index}=1$.`));
  const { root, harness } = await render(blocks, undefined, {}, root => {
    setTimeout(() => { partialBlocks = root.querySelectorAll("[data-reader-block-id]").length; }, 0);
  });
  assert.ok(partialBlocks > 0 && partialBlocks < blocks.length, `rendered during yield: ${partialBlocks}`);
  assert.equal(root.querySelectorAll("[data-reader-block-id]").length, 125);
  assert.equal(root.querySelectorAll(".test-math").length, 125);
  assert.equal(harness.calls.filter(call => call.startsWith("math:")).length, 125);
  assert.equal(harness.calls.filter(call => call === "flush").length, 1);
});

test("cancelling a long render at its first yield stops later blocks and formulas", async () => {
  let current = true;
  const blocks = Array.from({ length: 125 }, (_, index) => block(`body-${index}`, "paragraph", `Formula $x_${index}=1$.`));
  const { root, harness } = await render(blocks, undefined, { isCurrent: () => current }, () => {
    setTimeout(() => { current = false; }, 0);
  });
  const rendered = root.querySelectorAll("[data-reader-block-id]").length;
  assert.ok(rendered > 0 && rendered < blocks.length);
  assert.equal(harness.calls.filter(call => call.startsWith("math:")).length, rendered);
  assert.equal(harness.calls.includes("flush"), false);
});


test("page tracker coalesces scroll frames and reuses cached geometry, then disposes listeners", async () => {
  const { root } = await render(Array.from({ length: 100 }, (_, index) =>
    block(`body-${index}`, "paragraph", "Body text.", { sources: [{ page: index + 1 }] })));
  let measurements = 0;
  root.scrollTop = 0;
  root.getBoundingClientRect = () => { measurements++; return rectangle(0, 500); };
  Array.from(root.querySelectorAll<HTMLElement>(".pdf-reader-block")).forEach((element, index) => {
    element.getBoundingClientRect = () => { measurements++; return rectangle(index * 100 - root.scrollTop, 90); };
  });
  const win = root.ownerDocument.defaultView!;
  /* eslint-disable @typescript-eslint/unbound-method -- restored verbatim after the test */
  const request = win.requestAnimationFrame;
  const cancel = win.cancelAnimationFrame;
  /* eslint-enable @typescript-eslint/unbound-method -- end of saved originals */
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  win.requestAnimationFrame = callback => { frames.set(++nextFrame, callback); return nextFrame; };
  win.cancelAnimationFrame = id => { frames.delete(id); };
  const pages: number[] = [];
  const tracker = (await renderer).createSourcePageTracker(root, page => pages.push(page));
  try {
    assert.equal(tracker.getPage(), 1);
    const initialMeasurements = measurements;
    for (let index = 0; index <= 100; index++) {
      root.scrollTop = index * 20;
      root.dispatchEvent(new win.Event("scroll"));
    }
    assert.equal(frames.size, 1);
    assert.equal(tracker.getPage(), 21);
    assert.equal((await renderer).getVisibleSourcePage(root), 21);
    assert.equal(measurements, initialMeasurements);
    const callback = frames.values().next().value!;
    frames.clear(); callback(0);
    assert.deepEqual(pages, [21]);
    assert.equal(measurements, initialMeasurements);
    root.dispatchEvent(new win.Event("scroll"));
    tracker.dispose();
    assert.equal(frames.size, 0);
    root.dispatchEvent(new win.Event("scroll"));
    assert.equal(frames.size, 0);
    assert.equal(tracker.getPage(), undefined);
  } finally { tracker.dispose(); win.requestAnimationFrame = request; win.cancelAnimationFrame = cancel; }
});

test("page tracker handles hidden roots, closed folds, toggling and resize", async () => {
  const { root } = await render([
    block("reference-1", "references", "First source."),
    block("reference-2", "references", "Second source.", { sources: [{ page: 2 }] }),
    block("body", "paragraph", "Following body.", { sources: [{ page: 3 }] }),
  ]);
  root.scrollTop = 125;
  let height = 0;
  let bodyTop = 100;
  root.getBoundingClientRect = () => rectangle(0, height);
  const fold = root.querySelector<HTMLDetailsElement>("details")!;
  root.querySelector<HTMLElement>("summary")!.getBoundingClientRect = () => rectangle(-root.scrollTop, 30);
  root.querySelector<HTMLElement>('[data-reader-block-id="reference-1"]')!.getBoundingClientRect = () => rectangle(40 - root.scrollTop, 90);
  root.querySelector<HTMLElement>('[data-reader-block-id="reference-2"]')!.getBoundingClientRect = () => rectangle(140 - root.scrollTop, 100);
  root.querySelector<HTMLElement>('[data-reader-block-id="body"]')!.getBoundingClientRect = () => rectangle(bodyTop - root.scrollTop, 100);
  const tracker = (await renderer).createSourcePageTracker(root, () => {});
  try {
    assert.equal(tracker.getPage(), undefined);
    height = 500;
    assert.equal(tracker.getPage(), 3);
    fold.setAttribute("open", ""); bodyTop = 500;
    fold.dispatchEvent(new root.ownerDocument.defaultView!.Event("toggle", { bubbles: true }));
    assert.equal(tracker.getPage(), 2);
    root.scrollTop = 400;
    root.ownerDocument.defaultView!.dispatchEvent(new root.ownerDocument.defaultView!.Event("resize"));
    assert.equal(tracker.getPage(), 3);
  } finally { tracker.dispose(); }
});

test("an unknown-size image load invalidates page offsets while reserved image loads do not", async () => {
  const { root } = await render([
    block("unknown", "figure", "", { asset: "unknown.png" }),
    block("body", "paragraph", "Body on page two.", { sources: [{ page: 2 }] }),
    block("reserved", "figure", "", { asset: "reserved.png", sources: [{ page: 2 }] }),
  ], undefined, { assetUrl: reference => `app://local/${reference}`,
    assetDimensions: reference => reference === "reserved.png" ? { width: 100, height: 50 } : undefined });
  root.scrollTop = 0;
  let measurements = 0;
  let bodyTop = 120;
  root.getBoundingClientRect = () => rectangle(0, 500);
  const unknown = root.querySelector<HTMLElement>('[data-reader-block-id="unknown"]')!;
  unknown.getBoundingClientRect = () => { measurements++; return rectangle(-root.scrollTop, bodyTop); };
  root.querySelector<HTMLElement>('[data-reader-block-id="body"]')!.getBoundingClientRect = () => { measurements++; return rectangle(bodyTop - root.scrollTop, 100); };
  const reserved = root.querySelector<HTMLElement>('[data-reader-block-id="reserved"]')!;
  reserved.getBoundingClientRect = () => { measurements++; return rectangle(bodyTop + 120 - root.scrollTop, 60); };
  const tracker = (await renderer).createSourcePageTracker(root, () => {});
  try {
    tracker.getPage();
    const initial = measurements;
    reserved.querySelector("img")!.dispatchEvent(new root.ownerDocument.defaultView!.Event("load", { bubbles: true }));
    tracker.getPage();
    assert.equal(measurements, initial);
    const image = unknown.querySelector<HTMLImageElement>("img")!;
    Object.defineProperties(image, { naturalWidth: { value: 100 }, naturalHeight: { value: 400 } });
    bodyTop = 400;
    image.dispatchEvent(new root.ownerDocument.defaultView!.Event("load", { bubbles: true }));
    root.scrollTop = 150;
    assert.equal(tracker.getPage(), 1);
    assert.ok(measurements > initial);
  } finally { tracker.dispose(); }
});

test("page tracker reports rebuild attempts and isolated invalidation counters without counting scrolls", async () => {
  const { root } = await render([block("body", "paragraph", "Body text.")]);
  const win = root.ownerDocument.defaultView!;
  const originalObserver = win.ResizeObserver;
  /* eslint-disable @typescript-eslint/unbound-method -- restored verbatim after the test */
  const originalRequest = win.requestAnimationFrame;
  const originalCancel = win.cancelAnimationFrame;
  /* eslint-enable @typescript-eslint/unbound-method -- end of saved originals */
  let observerCallback: ResizeObserverCallback | undefined;
  win.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) { observerCallback = callback; }
    observe() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  win.requestAnimationFrame = () => 1;
  win.cancelAnimationFrame = () => {};
  let height = 0;
  root.scrollTop = 0;
  root.getBoundingClientRect = () => rectangle(0, height);
  root.querySelector<HTMLElement>(".pdf-reader-block")!.getBoundingClientRect = () => rectangle(-root.scrollTop, 100);
  const image = root.createEl("img");
  const reserved = root.createEl("img");
  reserved.dataset.readerLayoutReserved = "true";
  const tracker = (await renderer).createSourcePageTracker(root, () => {});
  try {
    assert.equal(tracker.getPage(), undefined);
    assert.equal(tracker.getPage(), undefined);
    assert.equal(tracker.getStats().rebuilds, 2);
    height = 500;
    assert.equal(tracker.getPage(), 1);
    for (let index = 0; index < 20; index++) {
      root.dispatchEvent(new win.Event("scroll"));
      tracker.getPage();
    }
    assert.deepEqual(tracker.getStats().invalidations, {});
    assert.equal(tracker.getStats().rebuilds, 3);
    reserved.dispatchEvent(new win.Event("load", { bubbles: true }));
    tracker.getPage();
    assert.equal(tracker.getStats().rebuilds, 3);
    image.dispatchEvent(new win.Event("load", { bubbles: true }));
    root.dispatchEvent(new win.Event("error"));
    root.dispatchEvent(new win.Event("toggle"));
    win.dispatchEvent(new win.Event("resize"));
    observerCallback!([], {} as ResizeObserver);
    tracker.getPage();
    const stats = tracker.getStats();
    assert.equal(stats.rebuilds, 4);
    assert.ok(Number.isFinite(stats.rebuildMs) && stats.rebuildMs >= 0);
    assert.deepEqual(stats.invalidations, { load: 1, error: 1, toggle: 1, "window-resize": 1, "resize-observer": 1 });
    stats.rebuilds = 999;
    stats.invalidations.load = 999;
    assert.equal(tracker.getStats().rebuilds, 4);
    assert.equal(tracker.getStats().invalidations.load, 1);
  } finally {
    tracker.dispose();
    win.ResizeObserver = originalObserver;
    win.requestAnimationFrame = originalRequest;
    win.cancelAnimationFrame = originalCancel;
  }
});

test("search text covers reader content but not page markers or source-tool buttons", async () => {
  const { root } = await render([
    block("body", "paragraph", "Stress relaxation of transient networks."),
    block("figure", "figure", "", { captions: ["Fig. 2. Relaxation modulus."] }),
  ]);
  const { blockSearchText } = await renderer;
  const [body, figure] = Array.from(root.querySelectorAll<HTMLElement>("[data-reader-block-id]"));
  assert.ok(body!.textContent?.includes("原文 p.1"));
  assert.ok(body!.textContent?.includes("PDF p. 1"));
  const text = blockSearchText(body!);
  assert.ok(text.includes("Stress relaxation"));
  assert.ok(!text.includes("原文") && !text.includes("复制页链") && !text.includes("PDF p."));
  assert.ok(blockSearchText(figure!).includes("Relaxation modulus"));
});

test("a figure MinerU split into image blocks keeps a spanning ambiguous equation as its own block", async () => {
  const at = (page: number, bbox: [number, number, number, number]) => ({ sources: [{ page, bbox }] });
  const { root } = await render([
    block("intro", "paragraph", "Before the figure."),
    block("panel-a", "figure", "", { asset: "a.png", captions: ["(a)"], ...at(7, [0.5, 0.1, 0.9, 0.3]) }),
    block("panel-b", "figure", "", { asset: "b.png", captions: ["(b)"], ...at(7, [0.5, 0.3, 0.7, 0.5]) }),
    block("panel-c", "figure", "", { asset: "c.png", ...at(7, [0.7, 0.3, 0.9, 0.5]) }),
    block("formula", "equation", "$$PS_{300}$$", at(7, [0.6, 0.5, 0.8, 0.52])),
    { ...block("caption", "paragraph", "F I G U R E 2 The evolution of particles", at(7, [0.5, 0.53, 0.9, 0.6])), segments: [{ field: "text", index: 0, sourceHash: "h-caption" }] },
    block("after", "paragraph", "After the figure."),
  ], undefined, { assetUrl: reference => `app://local/${reference}` });
  const figures = root.querySelectorAll("figure");
  assert.equal(figures.length, 1);
  const images = Array.from(figures[0]!.querySelectorAll<HTMLImageElement>("img"));
  assert.deepEqual(images.map(image => image.getAttribute("src")), ["app://local/a.png", "app://local/b.png", "app://local/c.png"]);
  assert.deepEqual(images.map(image => (image.parentElement as HTMLElement).style.flexBasis), ["100.00%", "50.00%", "50.00%"]);
  assert.equal(figures[0]!.querySelector("figcaption")?.textContent, "F I G U R E 2 The evolution of particles");
  assert.ok(figures[0]!.querySelector('figcaption [data-segment="h-caption"]'), "the caption paragraph keeps its translation unit");
  assert.ok(!root.textContent?.includes("(a)"));
  assert.equal(root.querySelectorAll(".pdf-reader-equation").length, 1);
  assert.equal(root.querySelector('[data-reader-block-id="formula"] .test-math')?.getAttribute("data-source"), "PS_{300}");
  const order = Array.from(root.querySelectorAll<HTMLElement>("[data-reader-block-id]")).map(element => element.dataset.readerBlockId);
  assert.deepEqual(order, ["intro", "panel-a", "formula", "after"]);
});

const SYNTHETIC_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC";

test("AC-02: outside-crop panel label renders once inside its unique panel; inside-crop label is deduplicated", async () => {
  const at = (page: number, bbox: [number, number, number, number]) => ({ sources: [{ page, bbox }] });
  const { root } = await render([
    block("p-a", "figure", "", { asset: "p-a.jpg", ...at(7, [0.1, 0.25, 0.45, 0.42]) }),
    block("p-b", "figure", "", { asset: "p-b.jpg", ...at(7, [0.55, 0.25, 0.85, 0.42]) }),
    block("p-c", "figure", "", { asset: "p-c.jpg", ...at(7, [0.1, 0.46, 0.45, 0.613]) }),
    block("p-d", "figure", "", { asset: "p-d.jpg", ...at(7, [0.618, 0.462, 0.816, 0.613]) }),
    block("outside-label", "equation", "$$S_{104}$$", at(7, [0.665, 0.615, 0.768, 0.631])),
    { ...block("cap-out", "paragraph", "F I G U R E 4 Complete caption for panels.", at(7, [0.1, 0.64, 0.85, 0.7])), segments: [{ field: "text", index: 0, sourceHash: "h-cap-out" }] },
    block("sep", "paragraph", "Separator paragraph between figures.", { sources: [{ page: 8 }] }),
    block("in-a", "figure", "", { asset: "in-a.png", ...at(8, [0.1, 0.2, 0.45, 0.4]) }),
    block("in-b", "figure", "", { asset: "in-b.png", ...at(8, [0.55, 0.2, 0.85, 0.4]) }),
    block("inside-label", "equation", "$$S_{in}$$", at(8, [0.62, 0.34, 0.78, 0.39])),
    block("cap-in", "paragraph", "Figure 5. Synthetic in-crop label counterexample.", at(8, [0.1, 0.42, 0.85, 0.48])),
  ], undefined, {
    assetUrl: reference => reference.startsWith("in-") ? SYNTHETIC_PNG : `app://local/${reference}`,
  });

  const figures = Array.from(root.querySelectorAll<HTMLElement>("figure.pdf-reader-figure-group"));
  assert.equal(figures.length, 2);

  // Group 1: outside label appears once inside panel p-d, nowhere else, with full caption and translation segment.
  const outPanels = Array.from(figures[0]!.querySelectorAll<HTMLElement>(".pdf-reader-figure-panel"));
  assert.equal(outPanels.length, 4);
  assert.equal(outPanels[3]!.querySelector("img")?.getAttribute("src"), "app://local/p-d.jpg");
  assert.equal(outPanels[3]!.querySelectorAll(".test-math").length, 1);
  assert.equal(outPanels[3]!.querySelector<HTMLElement>(".test-math")?.dataset.source, "S_{104}");
  for (let i = 0; i < 3; i++) assert.equal(outPanels[i]!.querySelector(".test-math"), null);
  assert.equal(root.querySelectorAll('[data-source="S_{104}"]').length, 1);
  assert.equal(root.querySelector('[data-reader-block-id="outside-label"]'), null);
  assert.equal(figures[0]!.querySelector("figcaption")?.textContent, "F I G U R E 4 Complete caption for panels.");
  assert.ok(figures[0]!.querySelector('figcaption [data-segment="h-cap-out"]'));

  // Group 2: in-crop label already inside synthetic PNG crop is suppressed so it is not duplicated.
  const inPanels = Array.from(figures[1]!.querySelectorAll<HTMLElement>(".pdf-reader-figure-panel"));
  assert.equal(inPanels.length, 2);
  assert.equal(inPanels[1]!.querySelector("img")?.getAttribute("src"), SYNTHETIC_PNG);
  assert.equal(figures[1]!.querySelector(".test-math"), null);
  assert.equal(root.querySelector('[data-reader-block-id="inside-label"]'), null);
  assert.equal(figures[1]!.querySelector("figcaption")?.textContent, "Figure 5. Synthetic in-crop label counterexample.");
});

test("AC-02: panel label falls back to backup crop image, missing-bbox equations stay suppressed, unavailable panel image keeps equation block", async () => {
  const at = (page: number, bbox: [number, number, number, number]) => ({ sources: [{ page, bbox }] });
  const { root } = await render([
    block("fb-a", "figure", "", { asset: "fb-a.jpg", ...at(7, [0.1, 0.1, 0.45, 0.3]) }),
    block("fb-b", "figure", "", { asset: "fb-b.jpg", ...at(7, [0.55, 0.1, 0.85, 0.3]) }),
    block("fb-label", "equation", "$$bad_tex$$", { asset: "fallback/fb-label.png", ...at(7, [0.6, 0.302, 0.8, 0.32]) }),
    block("fb-cap", "paragraph", "Figure 1. Fallback label figure.", at(7, [0.1, 0.35, 0.85, 0.4])),
    block("legacy-img", "figure", "", { asset: "legacy.jpg", sources: [{ page: 8 }] }),
    block("legacy-eq", "equation", "$$PS_{legacy}$$", { sources: [{ page: 8 }] }),
    block("legacy-cap", "paragraph", "Figure 2. Legacy no-bbox equation.", { sources: [{ page: 8 }] }),
    block("unavail-a", "figure", "", { asset: "ok.jpg", ...at(9, [0.1, 0.1, 0.45, 0.3]) }),
    block("unavail-b", "figure", "", { asset: "missing.jpg", ...at(9, [0.55, 0.1, 0.85, 0.3]) }),
    block("unavail-eq", "equation", "$$S_{keep}$$", at(9, [0.6, 0.302, 0.8, 0.32])),
    block("unavail-cap", "paragraph", "Figure 3. Missing panel asset keeps label.", at(9, [0.1, 0.35, 0.85, 0.4])),
  ], "bad_tex", {
    assetUrl: reference => reference === "missing.jpg" ? "" : `app://local/${reference}`,
  });

  const figures = Array.from(root.querySelectorAll<HTMLElement>("figure.pdf-reader-figure-group"));
  assert.equal(figures.length, 3);
  const fbPanels = Array.from(figures[0]!.querySelectorAll<HTMLElement>(".pdf-reader-figure-panel"));
  assert.equal(fbPanels[1]!.querySelector(".pdf-reader-equation-body img")?.getAttribute("src"), "app://local/fallback/fb-label.png");
  assert.equal(root.querySelector('[data-reader-block-id="legacy-eq"]'), null);
  assert.equal(root.querySelector('[data-reader-block-id="unavail-eq"] .test-math')?.getAttribute("data-source"), "S_{keep}");
});

test("AC-06: callout HTML renders safely with emphasis and TeX, no trailing br, and clean separation in readableText/search/copy", async () => {
  const { blockSearchText, needsCleanCopy, readableText } = await renderer;
  const callout: RenderBlock = {
    ...block("callout-22", "paragraph", "Lead note with $x^2$\nSecond line", {
      html: "<div>Lead <em>note</em> with $x^2$</div><div>Second line</div>   ",
      sources: [{ page: 2, bbox: [0.07, 0.08, 0.57, 0.52] }],
    }),
    segments: [{ field: "text", index: 0, sourceHash: "h-callout" }],
  };
  const malformedCallout: RenderBlock = block("callout-bad", "paragraph", "Fallback $bad_eq$", {
    html: "<p>Fallback $bad_eq$</p><p>Next line</p>\n",
    sources: [{ page: 2 }],
  });
  const { root } = await render([callout, malformedCallout], "bad_eq", {
    translation: hash => hash === "h-callout" ? "导语与公式 $x^2$\n第二行" : undefined,
  });

  const section = root.querySelector<HTMLElement>('[data-reader-block-id="callout-22"]')!;
  const enLayer = section.querySelector<HTMLElement>('.pw-block[data-segment="h-callout"] > .pw-layer[lang="en"]')!;
  const zhLayer = section.querySelector<HTMLElement>('.pw-block[data-segment="h-callout"] > .pw-layer[lang="zh"]')!;
  assert.equal(zhLayer.getAttribute("aria-hidden"), "true");
  assert.equal(enLayer.querySelector("em")?.textContent, "note");
  assert.equal(enLayer.querySelector<HTMLElement>(".test-math")?.dataset.source, "x^2");
  const readable = readableText(section);
  assert.equal(readable, "Lead note with x^2\nSecond line");
  assert.equal(blockSearchText(section), "Lead note with x^2\nSecond line");
  assert.ok(!readable.includes("x^2Second") && !readable.includes("<div"));
  assert.equal(enLayer.querySelectorAll("br").length, 1, "only one separator br between containers; trailing whitespace must not add a trailing br");
  const trailingNodes = Array.from(enLayer.childNodes).filter(node => node.nodeType !== 3 || Boolean(node.textContent?.trim()));
  assert.equal(trailingNodes.at(-1)?.textContent, "Second line");
  assert.ok(!enLayer.textContent?.includes("<div") && !enLayer.textContent?.includes("</div>"));

  // Clean copy path drops hidden Chinese layer, page markers and tool buttons while keeping block separation.
  const copyFragment = createFragment();
  const wrapper = copyFragment.createDiv();
  wrapper.append(section.cloneNode(true));
  assert.equal(needsCleanCopy(copyFragment), true);
  assert.equal(readableText(wrapper), "Lead note with x^2\nSecond line");

  // Malformed formula inside callout HTML keeps readable fallback and marks the block.
  const badSection = root.querySelector<HTMLElement>('[data-reader-block-id="callout-bad"]')!;
  assert.ok(badSection.classList.contains("has-math-fallback"));
  assert.equal(badSection.querySelector(".pdf-reader-math-fallback")?.textContent, "bad_eq");
  assert.equal(readableText(badSection), "Fallback bad_eq\nNext line");
});

test("AC-03: English compound unit spacing and exponent remain intact across text, HTML and readableText", async () => {
  const { readableText } = await renderer;
  const blocks: RenderBlock[] = [
    block("u-plain", "paragraph", "Power density reaches 2 W m⁻³ under load.", { sources: [{ page: 2 }] }),
    block("u-html", "paragraph", "Power density reaches 2 W m<sup>-3</sup> and $2\\text{ W m}^{-3}$.", {
      html: "<div>Power density reaches 2 W m<sup>-3</sup> and $2\\text{ W m}^{-3}$.</div>",
      sources: [{ page: 2 }],
    }),
  ];
  const { root } = await render(blocks);
  const plainText = readableText(root.querySelector('[data-reader-block-id="u-plain"]')!);
  const htmlSection = root.querySelector<HTMLElement>('[data-reader-block-id="u-html"]')!;
  const htmlText = readableText(htmlSection);
  assert.ok(plainText.includes("2 W m⁻³"));
  assert.ok(!plainText.includes("Wm⁻³"));
  assert.ok(htmlText.includes("2 W m-3"));
  assert.ok(!htmlText.includes("Wm-3"));
  assert.equal(htmlSection.querySelector("sup")?.textContent, "-3");
  assert.equal(htmlSection.querySelector<HTMLElement>(".test-math")?.dataset.source, "2\\text{ W m}^{-3}");
});

test("AC-01 & AC-04 & AC-05: source buttons fire exact pages matching clicked block source boxes and preserve anchors", async () => {
  const { readableText } = await renderer;
  const clicked: Array<{ blockId: string; page: number; boxes: Array<[number, number, number, number] | undefined> }> = [];
  let activeBlock: ReaderBlock | undefined;
  const blocks: RenderBlock[] = [
    // AC-01: cross-page body paragraph + separate callout box
    block("block-12", "paragraph", "Body paragraph starts on page one and continues smoothly on page two.", {
      sources: [
        { page: 1, bbox: [0.586, 0.882, 0.932, 0.94] },
        { page: 2, bbox: [0.233, 0.534, 0.576, 0.563] },
      ],
    }),
    block("block-22", "paragraph", "Callout box summary", {
      html: "<div>Callout box summary</div>",
      sources: [{ page: 2, bbox: [0.07, 0.075, 0.571, 0.52] }],
    }),
    // AC-04: cross-float body continuation + Scheme caption above figure
    block("block-70", "paragraph", "Sentence starts before float and finishes after scheme figure.", {
      sources: [
        { page: 4, bbox: [0.55, 0.85, 0.92, 0.92] },
        { page: 5, bbox: [0.08, 0.65, 0.45, 0.72] },
      ],
    }),
    block("block-75", "paragraph", "S CH E M E 1 (a) Conceptual pathway.", {
      sources: [{ page: 5, bbox: [0.08, 0.1, 0.45, 0.16] }],
    }),
    block("block-76", "figure", "", {
      asset: "scheme-1.jpg",
      sources: [{ page: 5, bbox: [0.08, 0.18, 0.45, 0.6] }],
    }),
    block("block-111", "paragraph", "The energy relation is written as follows:", {
      sources: [{ page: 5, bbox: [0.08, 0.34, 0.91, 0.38] }],
    }),
    // AC-05: display equation, adjacent number, and independent following paragraph anchor
    block("block-112", "equation", "$$E = mc^2$$", {
      sources: [{ page: 5, bbox: [0.15, 0.4, 0.75, 0.45] }],
    }),
    block("block-113", "paragraph", "(21)", {
      sources: [{ page: 5, bbox: [0.85, 0.44, 0.91, 0.46] }],
    }),
    block("block-114", "paragraph", "where $m$ is the rest mass.", {
      sources: [{ page: 5, bbox: [0.08, 0.48, 0.91, 0.56] }],
    }),
  ];
  const byId = new Map(blocks.map(item => [item.id, item]));
  const { root } = await render(blocks, undefined, {
    assetUrl: reference => `app://local/${reference}`,
    onSource: page => {
      assert.ok(activeBlock);
      clicked.push({
        blockId: activeBlock.id,
        page,
        boxes: activeBlock.sources.filter(source => source.page === page).map(source => source.bbox),
      });
    },
  });

  const clickSourceButtons = (blockId: string) => {
    const section = root.querySelector<HTMLElement>(`[data-reader-block-id="${blockId}"]`)!;
    assert.ok(section, `missing block ${blockId}`);
    activeBlock = byId.get(blockId);
    const buttons = Array.from(section.querySelectorAll<HTMLButtonElement>(".pdf-reader-block-tools button"))
      .filter(button => button.textContent?.startsWith("原文 p."));
    for (const button of buttons) button.dispatchEvent(new root.ownerDocument.defaultView!.Event("click"));
  };

  clickSourceButtons("block-12");
  clickSourceButtons("block-22");
  clickSourceButtons("block-70");
  clickSourceButtons("block-114");

  assert.deepEqual(clicked, [
    { blockId: "block-12", page: 1, boxes: [[0.586, 0.882, 0.932, 0.94]] },
    { blockId: "block-12", page: 2, boxes: [[0.233, 0.534, 0.576, 0.563]] },
    { blockId: "block-22", page: 2, boxes: [[0.07, 0.075, 0.571, 0.52]] },
    { blockId: "block-70", page: 4, boxes: [[0.55, 0.85, 0.92, 0.92]] },
    { blockId: "block-70", page: 5, boxes: [[0.08, 0.65, 0.45, 0.72]] },
    { blockId: "block-114", page: 5, boxes: [[0.08, 0.48, 0.91, 0.56]] },
  ]);

  // AC-04: caption stays pure in figcaption; continuation occurs once in body.
  const figure = root.querySelector<HTMLElement>('[data-reader-block-id="block-76"]')!;
  assert.equal(figure.querySelector("figcaption")?.textContent, "S CH E M E 1 (a) Conceptual pathway.");
  assert.equal(readableText(root).split("finishes after scheme figure.").length - 1, 1);

  // AC-05: equation and (21) stay adjacent, (21) occurs once, and block-114 keeps its own anchor.
  const eqSection = root.querySelector<HTMLElement>('[data-reader-block-id="block-112"]')!;
  const numSection = root.querySelector<HTMLElement>('[data-reader-block-id="block-113"]')!;
  const nextSection = root.querySelector<HTMLElement>('[data-reader-block-id="block-114"]')!;
  assert.equal(eqSection.nextElementSibling, numSection);
  assert.equal(numSection.nextElementSibling, nextSection);
  assert.equal(readableText(root).split("(21)").length - 1, 1);
  assert.ok(readableText(nextSection).includes("where m is the rest mass."));
});

test("AC-07: publication metadata stays folded by default and after reopen while research notes and acknowledgements remain visible", async () => {
  const pagesClicked: number[] = [];
  const blocks: RenderBlock[] = [
    block("intro-h", "heading", "Introduction", { level: 2, sources: [{ page: 1 }] }),
    block("affil-14", "metadata", "1 Department of Materials, City 10000.", { hiddenByDefault: true, sources: [{ page: 1 }] }),
    block("table-note", "footnote", "a Values measured at 298 K.", { sources: [{ page: 6 }] }),
    block("orcid-h", "metadata", "ORCID", { hiddenByDefault: true, sources: [{ page: 11 }] }),
    block("orcid-v", "metadata", "Author A: 0000-0001-0000-0000", { hiddenByDefault: true, sources: [{ page: 11 }] }),
    block("ack-h", "heading", "Acknowledgements", { level: 2, sources: [{ page: 15 }] }),
    block("ack-body", "paragraph", "We thank the microscopy facility for assistance.", { sources: [{ page: 15 }] }),
    block("pub-note", "metadata", "Publisher's note: jurisdiction claims remain neutral.", { hiddenByDefault: true, sources: [{ page: 15 }] }),
  ];
  const { root } = await render(blocks, undefined, { onSource: page => pagesClicked.push(page) });

  const checkDefaultState = () => {
    const folds = Array.from(root.querySelectorAll<HTMLDetailsElement>('details.pdf-reader-fold[data-fold-kind="metadata"]'));
    assert.ok(folds.length >= 1);
    for (const fold of folds) {
      assert.equal(fold.hasAttribute("open"), false);
      assert.ok(!fold.open);
      assert.equal(fold.querySelector("summary")?.textContent, "文献信息");
    }
    for (const id of ["affil-14", "orcid-h", "orcid-v", "pub-note"]) {
      assert.equal(root.querySelector(`[data-reader-block-id="${id}"]`)?.closest("details")?.getAttribute("data-fold-kind"), "metadata", id);
    }
    for (const id of ["table-note", "ack-h", "ack-body"]) {
      const node = root.querySelector(`[data-reader-block-id="${id}"]`);
      assert.ok(node, id);
      assert.equal(node.closest("details"), null, `${id} must stay visible outside folds`);
    }
    return folds;
  };

  const folds = checkDefaultState();
  // Expand folds and verify content & source callback are accessible.
  for (const fold of folds) { fold.setAttribute("open", ""); fold.open = true; }
  const pubButton = root.querySelector<HTMLButtonElement>('[data-reader-block-id="pub-note"] .pdf-reader-block-tools button')!;
  pubButton.dispatchEvent(new root.ownerDocument.defaultView!.Event("click"));
  assert.deepEqual(pagesClicked, [15]);

  // Reopen reading mode: publication metadata returns to closed default state.
  await (await renderer).renderReader(root, blocks, {
    fontSize: 18, lineHeight: 1.5, assetUrl: () => "", onSource: page => pagesClicked.push(page), onCopy: () => {}, onZoom: () => {},
  });
  checkDefaultState();
});
