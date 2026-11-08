import assert from "node:assert/strict";
import test from "node:test";

import { horizontalWheelStep, type WheelLike } from "./use-horizontal-wheel.ts";

function wheel(overrides: Partial<WheelLike> = {}): WheelLike {
  return { deltaX: 0, deltaY: 100, deltaMode: 0, ctrlKey: false, ...overrides };
}

test("a mouse wheel's vertical travel becomes horizontal travel", () => {
  assert.equal(horizontalWheelStep(wheel(), 800), 100);
  assert.equal(horizontalWheelStep(wheel({ deltaY: -120 }), 800), -120);
});

test("a trackpad's sideways swipe stays with the browser", () => {
  assert.equal(horizontalWheelStep(wheel({ deltaX: 120, deltaY: 30 }), 800), 0);
  assert.equal(horizontalWheelStep(wheel({ deltaX: 40, deltaY: 40 }), 800), 0);
});

test("Ctrl+wheel is zoom, not a scroll", () => {
  assert.equal(horizontalWheelStep(wheel({ ctrlKey: true }), 800), 0);
});

test("line and page deltas are scaled to pixels", () => {
  assert.equal(horizontalWheelStep(wheel({ deltaY: 3, deltaMode: 1 }), 800), 48);
  assert.equal(horizontalWheelStep(wheel({ deltaY: 2, deltaMode: 2 }), 800), 1600);
  assert.equal(horizontalWheelStep(wheel({ deltaMode: 0 }), 300), 100);
});

test("no travel asks for nothing", () => {
  assert.equal(horizontalWheelStep(wheel({ deltaY: 0 }), 800), 0);
});
