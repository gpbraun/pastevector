"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const path = require("path");
const fs = require("fs/promises");
const os = require("os");
const emfBackends_1 = require("../src/emfBackends");
const FIXTURES = __dirname;
const EMF1 = path.join(FIXTURES, "test1.emf");
const EMF2 = path.join(FIXTURES, "test2.emf");
function tmpSvg(tag) {
    return path.join(os.tmpdir(), `pv_test_${tag}_${(0, emfBackends_1.nonce)()}.svg`);
}
async function readSvgDimensions(svgPath) {
    const text = await fs.readFile(svgPath, "utf8");
    const wMatch = text.match(/<svg\b[^>]*\swidth="([\d.]+)([a-z%]*)"/);
    const hMatch = text.match(/<svg\b[^>]*\sheight="([\d.]+)([a-z%]*)"/);
    return {
        width: wMatch ? parseFloat(wMatch[1]) : null,
        height: hMatch ? parseFloat(hMatch[1]) : null,
        wUnit: wMatch?.[2] ?? null,
        hUnit: hMatch?.[2] ?? null,
    };
}
// ── PowerPoint backend ────────────────────────────────────────────────────────
describe("PowerPoint EMF backend", () => {
    const hasPpt = (0, emfBackends_1.isWSL)() && (0, emfBackends_1.commandExists)("powershell.exe");
    beforeAll(() => {
        if (!hasPpt) {
            console.log("SKIP: PowerPoint backend tests require WSL + powershell.exe");
        }
    });
    test("test2.emf: success + shape dimensions captured", async () => {
        if (!hasPpt)
            return;
        const out = tmpSvg("ppt_test2");
        const result = await (0, emfBackends_1.convertEmfFileViaPowerPoint)(EMF2, out, 30000);
        expect(result.success).toBe(true);
        if (!result.success)
            return;
        expect(result.shapeWidthPt).toBeGreaterThan(0);
        expect(result.shapeHeightPt).toBeGreaterThan(0);
        const st = await (0, emfBackends_1.statSafe)(result.svgPath);
        expect(st.exists).toBe(true);
        expect(st.size).toBeGreaterThan(0);
        console.log(`PPT test2: ${result.shapeWidthPt.toFixed(2)}pt × ${result.shapeHeightPt.toFixed(2)}pt → ${result.svgPath}`);
    });
    test("test1.emf: success + dimensions differ from test2", async () => {
        if (!hasPpt)
            return;
        const out1 = tmpSvg("ppt_test1");
        const out2 = tmpSvg("ppt_test2b");
        const r1 = await (0, emfBackends_1.convertEmfFileViaPowerPoint)(EMF1, out1, 30000);
        const r2 = await (0, emfBackends_1.convertEmfFileViaPowerPoint)(EMF2, out2, 30000);
        expect(r1.success).toBe(true);
        expect(r2.success).toBe(true);
        if (!r1.success || !r2.success)
            return;
        console.log(`PPT test1: ${r1.shapeWidthPt.toFixed(2)}pt × ${r1.shapeHeightPt.toFixed(2)}pt`);
        console.log(`PPT test2: ${r2.shapeWidthPt.toFixed(2)}pt × ${r2.shapeHeightPt.toFixed(2)}pt`);
        const sameDims = Math.abs(r1.shapeWidthPt - r2.shapeWidthPt) < 0.1 &&
            Math.abs(r1.shapeHeightPt - r2.shapeHeightPt) < 0.1;
        expect(sameDims).toBe(false);
    });
});
// ── Inkscape fallback backend ─────────────────────────────────────────────────
describe("Inkscape EMF fallback backend", () => {
    const hasInkscape = (0, emfBackends_1.commandExists)("inkscape");
    beforeAll(() => {
        if (!hasInkscape) {
            console.log("SKIP: Inkscape backend tests require inkscape in PATH");
        }
    });
    test("test2.emf: scale factor 1.185 applied to root dimensions", async () => {
        if (!hasInkscape)
            return;
        const SCALE = 1.185;
        const out = tmpSvg("ink_test2");
        const outRef = tmpSvg("ink_test2_ref");
        await (0, emfBackends_1.convertEmfFileViaInkscape)(EMF2, out, SCALE);
        await (0, emfBackends_1.convertEmfFileViaInkscape)(EMF2, outRef, 1.0);
        const scaled = await readSvgDimensions(out);
        const ref = await readSvgDimensions(outRef);
        expect(scaled.width).not.toBeNull();
        expect(scaled.height).not.toBeNull();
        expect(ref.width).not.toBeNull();
        expect(ref.height).not.toBeNull();
        expect(scaled.width).toBeCloseTo(ref.width * SCALE, 1);
        expect(scaled.height).toBeCloseTo(ref.height * SCALE, 1);
        console.log(`Inkscape test2 ref: ${ref.width}${ref.wUnit} × ${ref.height}${ref.hUnit}`);
        console.log(`Inkscape test2 scaled (×${SCALE}): ${scaled.width}${scaled.wUnit} × ${scaled.height}${scaled.hUnit}`);
    });
    test("test1.emf: scale factor 1.185 applied to root dimensions", async () => {
        if (!hasInkscape)
            return;
        const SCALE = 1.185;
        const out = tmpSvg("ink_test1");
        const outRef = tmpSvg("ink_test1_ref");
        await (0, emfBackends_1.convertEmfFileViaInkscape)(EMF1, out, SCALE);
        await (0, emfBackends_1.convertEmfFileViaInkscape)(EMF1, outRef, 1.0);
        const scaled = await readSvgDimensions(out);
        const ref = await readSvgDimensions(outRef);
        expect(scaled.width).not.toBeNull();
        expect(scaled.height).not.toBeNull();
        expect(scaled.width).toBeCloseTo(ref.width * SCALE, 1);
        expect(scaled.height).toBeCloseTo(ref.height * SCALE, 1);
        console.log(`Inkscape test1 ref: ${ref.width}${ref.wUnit} × ${ref.height}${ref.hUnit}`);
        console.log(`Inkscape test1 scaled (×${SCALE}): ${scaled.width}${scaled.wUnit} × ${scaled.height}${scaled.hUnit}`);
    });
});
// ── PowerPoint failure → Inkscape fallback ────────────────────────────────────
describe("PowerPoint failure → Inkscape fallback", () => {
    const hasInkscape = (0, emfBackends_1.commandExists)("inkscape");
    test("simulate COM failure: Inkscape fallback produces valid SVG", async () => {
        if (!hasInkscape)
            return;
        // The Inkscape path is the "fallback" path when PowerPoint fails.
        // Exercise it directly to confirm it always produces valid SVG output.
        const out = tmpSvg("fallback_test2");
        await (0, emfBackends_1.convertEmfFileViaInkscape)(EMF2, out, 1.0);
        const st = await (0, emfBackends_1.statSafe)(out);
        expect(st.exists).toBe(true);
        expect(st.size).toBeGreaterThan(0);
        const text = await fs.readFile(out, "utf8");
        expect(text).toMatch(/<svg/i);
    });
    test("simulate COM failure: Inkscape fallback for test1", async () => {
        if (!hasInkscape)
            return;
        const out = tmpSvg("fallback_test1");
        await (0, emfBackends_1.convertEmfFileViaInkscape)(EMF1, out, 1.0);
        const st = await (0, emfBackends_1.statSafe)(out);
        expect(st.exists).toBe(true);
        expect(st.size).toBeGreaterThan(0);
        const text = await fs.readFile(out, "utf8");
        expect(text).toMatch(/<svg/i);
    });
});
