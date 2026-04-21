import * as path from "path";
import * as fs from "fs/promises";
import * as os from "os";
import { convertEmfToSvg } from "../src/emf";
import { commandExists, statSafe, nonce } from "../src/util";

const FIXTURES = __dirname;
const EMF1 = path.join(FIXTURES, "test1.emf");
const EMF2 = path.join(FIXTURES, "test2.emf");

function tmpSvg(tag: string) {
  return path.join(os.tmpdir(), `pv_test_${tag}_${nonce()}.svg`);
}

async function readSvgDimensions(svgPath: string) {
  const text = await fs.readFile(svgPath, "utf8");
  const wMatch = text.match(/<svg\b[^>]*\swidth="([\d.]+)([a-z%]*)"/);
  const hMatch = text.match(/<svg\b[^>]*\sheight="([\d.]+)([a-z%]*)"/);
  return {
    width:  wMatch ? parseFloat(wMatch[1]) : null,
    height: hMatch ? parseFloat(hMatch[1]) : null,
    wUnit:  wMatch?.[2] ?? null,
    hUnit:  hMatch?.[2] ?? null,
  };
}

// ── emf2svg-conv pipeline ─────────────────────────────────────────────────────

describe("emf2svg-conv pipeline", () => {
  const hasConv = commandExists("emf2svg-conv");
  const hasInk  = commandExists("inkscape");

  beforeAll(() => {
    if (!hasConv) console.log("SKIP: emf2svg-conv pipeline tests require emf2svg-conv in PATH");
  });

  test("test2.emf: converts at 125% without fit → output exists and is SVG", async () => {
    if (!hasConv) return;
    const out = tmpSvg("conv_test2_nofit");
    await convertEmfToSvg(EMF2, out, 125, false);
    const st = await statSafe(out);
    expect(st.exists).toBe(true);
    expect(st.size).toBeGreaterThan(0);
    const text = await fs.readFile(out, "utf8");
    expect(text).toMatch(/<svg/i);
    const dims = await readSvgDimensions(out);
    console.log(`test2 125% nofit: ${dims.width}${dims.wUnit} × ${dims.height}${dims.hUnit}`);
  });

  test("test1.emf: converts at 125% without fit → output exists and is SVG", async () => {
    if (!hasConv) return;
    const out = tmpSvg("conv_test1_nofit");
    await convertEmfToSvg(EMF1, out, 125, false);
    const st = await statSafe(out);
    expect(st.exists).toBe(true);
    expect(st.size).toBeGreaterThan(0);
    const text = await fs.readFile(out, "utf8");
    expect(text).toMatch(/<svg/i);
    const dims = await readSvgDimensions(out);
    console.log(`test1 125% nofit: ${dims.width}${dims.wUnit} × ${dims.height}${dims.hUnit}`);
  });

  test("test2.emf: converts at 125% with Inkscape fit step → output exists and is SVG", async () => {
    if (!hasConv) return;
    const out = tmpSvg("conv_test2_fit");
    await convertEmfToSvg(EMF2, out, 125, hasInk);
    const st = await statSafe(out);
    expect(st.exists).toBe(true);
    expect(st.size).toBeGreaterThan(0);
    const text = await fs.readFile(out, "utf8");
    expect(text).toMatch(/<svg/i);
    const dims = await readSvgDimensions(out);
    console.log(`test2 125% fit=${hasInk}: ${dims.width}${dims.wUnit} × ${dims.height}${dims.hUnit}`);
  });

  test("test1.emf: converts at 125% with Inkscape fit step → output exists and is SVG", async () => {
    if (!hasConv) return;
    const out = tmpSvg("conv_test1_fit");
    await convertEmfToSvg(EMF1, out, 125, hasInk);
    const st = await statSafe(out);
    expect(st.exists).toBe(true);
    expect(st.size).toBeGreaterThan(0);
    const text = await fs.readFile(out, "utf8");
    expect(text).toMatch(/<svg/i);
    const dims = await readSvgDimensions(out);
    console.log(`test1 125% fit=${hasInk}: ${dims.width}${dims.wUnit} × ${dims.height}${dims.hUnit}`);
  });
});

// ── Scale factor exactness ────────────────────────────────────────────────────

describe("scaleSvgRootDimensions — exact factor behavior", () => {
  const hasConv = commandExists("emf2svg-conv");

  beforeAll(() => {
    if (!hasConv) console.log("SKIP: scale factor tests require emf2svg-conv in PATH");
  });

  test("scalePercent=125 → root dimensions × 0.8", async () => {
    if (!hasConv) return;
    const outRaw    = tmpSvg("scale_raw_125");
    const outScaled = tmpSvg("scale_125");
    await convertEmfToSvg(EMF2, outRaw,    100, false);
    await convertEmfToSvg(EMF2, outScaled, 125, false);
    const raw    = await readSvgDimensions(outRaw);
    const scaled = await readSvgDimensions(outScaled);
    expect(raw.width).not.toBeNull();
    expect(raw.height).not.toBeNull();
    expect(scaled.width).not.toBeNull();
    expect(scaled.height).not.toBeNull();
    expect(scaled.width!).toBeCloseTo(raw.width! * 0.8, 1);
    expect(scaled.height!).toBeCloseTo(raw.height! * 0.8, 1);
    console.log(`raw: ${raw.width}${raw.wUnit} × ${raw.height}${raw.hUnit}`);
    console.log(`125% (×0.8): ${scaled.width}${scaled.wUnit} × ${scaled.height}${scaled.hUnit}`);
  });

  test("scalePercent=100 → root dimensions unchanged", async () => {
    if (!hasConv) return;
    const outRef = tmpSvg("scale_ref_100");
    const out100 = tmpSvg("scale_100");
    await convertEmfToSvg(EMF2, outRef, 100, false);
    await convertEmfToSvg(EMF2, out100, 100, false);
    const ref  = await readSvgDimensions(outRef);
    const s100 = await readSvgDimensions(out100);
    expect(s100.width).not.toBeNull();
    expect(s100.height).not.toBeNull();
    expect(s100.width!).toBeCloseTo(ref.width!, 1);
    expect(s100.height!).toBeCloseTo(ref.height!, 1);
    console.log(`100% (unchanged): ${s100.width}${s100.wUnit} × ${s100.height}${s100.hUnit}`);
  });

  test("scalePercent=150 → root dimensions × 2/3", async () => {
    if (!hasConv) return;
    const outRaw = tmpSvg("scale_raw_150");
    const out150 = tmpSvg("scale_150");
    await convertEmfToSvg(EMF2, outRaw, 100, false);
    await convertEmfToSvg(EMF2, out150, 150, false);
    const raw  = await readSvgDimensions(outRaw);
    const s150 = await readSvgDimensions(out150);
    expect(s150.width).not.toBeNull();
    expect(s150.height).not.toBeNull();
    expect(s150.width!).toBeCloseTo(raw.width! * (2 / 3), 1);
    expect(s150.height!).toBeCloseTo(raw.height! * (2 / 3), 1);
    console.log(`150% (×2/3): ${s150.width}${s150.wUnit} × ${s150.height}${s150.hUnit}`);
  });
});

// ── Fit step independence ─────────────────────────────────────────────────────

describe("fitSvgPageWithInkscape — independent from scale correction", () => {
  const hasConv = commandExists("emf2svg-conv");
  const hasInk  = commandExists("inkscape");

  beforeAll(() => {
    if (!hasConv) console.log("SKIP: fit independence tests require emf2svg-conv in PATH");
    if (!hasInk)  console.log("NOTE: inkscape not found; fit=true and fit=false will produce identical output");
  });

  test("same 0.8 scale factor applied with and without fit step at 125%", async () => {
    if (!hasConv) return;
    const outRaw      = tmpSvg("fit_raw");
    const outWithFit  = tmpSvg("fit_with");
    const outNoFit    = tmpSvg("fit_without");
    await convertEmfToSvg(EMF2, outRaw,     100, false);
    await convertEmfToSvg(EMF2, outWithFit, 125, hasInk);
    await convertEmfToSvg(EMF2, outNoFit,   125, false);
    const raw      = await readSvgDimensions(outRaw);
    const withFit  = await readSvgDimensions(outWithFit);
    const withoutFit = await readSvgDimensions(outNoFit);
    expect(raw.width).not.toBeNull();
    expect(withFit.width).not.toBeNull();
    expect(withoutFit.width).not.toBeNull();
    // Both scaled outputs must be ≈ 0.8 × raw (fit step may shift the raw page
    // size, but the 0.8 factor must still be applied exactly once afterward).
    expect(withFit.width!  / raw.width!).toBeCloseTo(0.8, 1);
    expect(withoutFit.width! / raw.width!).toBeCloseTo(0.8, 1);
    console.log(`raw: ${raw.width}${raw.wUnit}`);
    console.log(`with fit   (125%): ${withFit.width}${withFit.wUnit}  ratio=${(withFit.width! / raw.width!).toFixed(4)}`);
    console.log(`without fit (125%): ${withoutFit.width}${withoutFit.wUnit}  ratio=${(withoutFit.width! / raw.width!).toFixed(4)}`);
  });
});

// ── emf2svg-conv missing → clear error ───────────────────────────────────────

describe("emf2svg-conv missing → clear error message", () => {
  test("throws with a message mentioning emf2svg-conv when tool is absent", async () => {
    // Exercise the error branch by pointing to a guaranteed-nonexistent binary.
    // We can't easily mock commandExists, but we can verify the error by
    // checking that a real missing-tool scenario throws the right message.
    // If emf2svg-conv IS present, we skip this test (the tool is available).
    if (commandExists("emf2svg-conv")) {
      console.log("SKIP: emf2svg-conv is present; cannot test the missing-tool error path");
      return;
    }
    await expect(
      convertEmfToSvg(EMF2, tmpSvg("missing_conv"), 125, false)
    ).rejects.toThrow(/emf2svg-conv/i);
  });
});

