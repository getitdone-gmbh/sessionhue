import assert from "node:assert/strict";
import test from "node:test";
import { PALETTE, checkContrast, colorDistance, contrastRatio, distinctColor, dotFor, ensureContrast, resolveColor } from "./colors.js";

test("contrast ratio matches WCAG reference values", () => {
  assert.equal(contrastRatio("#000000", "#ffffff").toFixed(2), "21.00");
  assert.equal(contrastRatio("#777777", "#ffffff").toFixed(2), "4.48");
});

test("every palette color reaches AAA with its label", () => {
  for (const [name, hex] of Object.entries(PALETTE)) assert.ok(checkContrast(hex).aaa, name);
});

test("ensureContrast lifts failing colors to AAA and keeps passing ones", () => {
  for (const hex of ["#0090ff", "#e5484d", "#777777", "#30a46c", "#8e4ec6", "#ffff00", "#000080"]) {
    const fixed = ensureContrast(hex, "AAA");
    assert.ok(checkContrast(fixed).ratio >= 7, `${hex} -> ${fixed}`);
  }
  assert.equal(ensureContrast("#70b8ff", "AAA"), "#70b8ff");
});

test("colors resolve from names, aliases and hex", () => {
  assert.equal(resolveColor("blau"), PALETTE.blue);
  assert.equal(resolveColor("#F80"), "#ff8800");
  assert.equal(resolveColor("nope"), null);
});

test("title dots follow the hue", () => {
  assert.equal(dotFor("#e5484d"), "🔴");
  assert.equal(dotFor("#0090ff"), "🔵");
  assert.equal(dotFor("#30a46c"), "🟢");
  assert.equal(dotFor("#8e4ec6"), "🟣");
  assert.equal(dotFor("#ffca16"), "🟡");
});

test("50 sessions get 50 distinct AAA colors", () => {
  const taken: string[] = [];
  for (let i = 0; i < 50; i++) taken.push(distinctColor(taken, "AAA"));
  assert.equal(new Set(taken).size, 50);
  for (const c of taken) assert.ok(checkContrast(c).aaa, c);
  // Named colors first, in a fixed order.
  assert.deepEqual(taken.slice(0, 3), [PALETTE.blue, PALETTE.orange, PALETTE.green]);
  assert.deepEqual(new Set(taken.slice(0, 12)), new Set(Object.values(PALETTE)));
  let min = Infinity;
  for (let i = 0; i < taken.length; i++) for (let j = i + 1; j < taken.length; j++) min = Math.min(min, colorDistance(taken[i], taken[j]));
  console.log(`min OKLab distance across 50 colors: ${min.toFixed(3)}`);
  assert.ok(min > 0.04, `colors too similar: ${min}`);
});
