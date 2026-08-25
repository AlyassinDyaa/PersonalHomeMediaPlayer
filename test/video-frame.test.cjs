/** Checks the window geometry rules the player relies on. */

const assert = require('node:assert');
const {
  windowedBounds, fullscreenBounds, dragBounds, resizeBounds, clampToDisplay, MIN_WIDTH,
} = require('../desktop/electron/video-frame.cjs');

const left = {
  bounds: { x: 0, y: 0, width: 1920, height: 1080 },
  workArea: { x: 0, y: 0, width: 1920, height: 1032 },
};
const right = {
  bounds: { x: 1920, y: 0, width: 2560, height: 1440 },
  workArea: { x: 1920, y: 0, width: 2560, height: 1392 },
};

let passed = 0;
let total = 0;
function check(name, fn) {
  total++;
  try {
    fn();
    passed++;
    console.log('[PASS] ' + name);
  } catch (error) {
    console.log('[FAIL] ' + name + ' — ' + error.message);
    process.exitCode = 1;
  }
}

check('fullscreen covers the whole display, not the work area', () => {
  assert.deepStrictEqual(fullscreenBounds(left), { x: 0, y: 0, width: 1920, height: 1080 });
  assert.deepStrictEqual(fullscreenBounds(right), { x: 1920, y: 0, width: 2560, height: 1440 });
});

check('a restored window is centred inside the work area', () => {
  const b = windowedBounds(left, 16 / 9);
  assert.ok(b.width < 1920 && b.height < 1032, 'fits the work area');
  assert.strictEqual(b.x + b.width / 2, 960, 'horizontally centred');
  assert.ok(Math.abs(b.y + b.height / 2 - 516) < 1, 'vertically centred');
});

check('a restored window keeps the video shape', () => {
  const b = windowedBounds(left, 2.39);
  assert.ok(Math.abs(b.width / b.height - 2.39) < 0.02, 'aspect held, got ' + (b.width / b.height));
});

check('a very tall video is bounded by the display height', () => {
  const b = windowedBounds(left, 0.5);
  assert.ok(b.height <= left.workArea.height, 'height ' + b.height + ' fits');
});

check('dragging a window follows the pointer exactly', () => {
  const drag = {
    kind: 'move',
    origin: { x: 500, y: 300 },
    startBounds: { x: 400, y: 200, width: 800, height: 450 },
    restoreTo: null,
  };
  const b = dragBounds(drag, { x: 560, y: 340 });
  assert.deepStrictEqual(b, { x: 460, y: 240, width: 800, height: 450 });
});

check('dragging a fullscreen window restores it under the pointer', () => {
  const restored = windowedBounds(left, 16 / 9);
  const drag = {
    kind: 'move',
    origin: { x: 960, y: 30 },              // grabbed the middle of the top bar
    startBounds: fullscreenBounds(left),
    restoreTo: restored,
  };
  const b = dragBounds(drag, { x: 960, y: 30 });
  assert.strictEqual(b.width, restored.width);
  // The grab was at the horizontal midpoint, so the smaller window is centred
  // on the cursor rather than jumping away from it.
  assert.ok(Math.abs(b.x + b.width / 2 - 960) < 2, 'stays under the cursor, x=' + b.x);
});

check('a drag onto another monitor lands there', () => {
  const drag = {
    kind: 'move',
    origin: { x: 900, y: 40 },
    startBounds: { x: 500, y: 20, width: 900, height: 506 },
    restoreTo: null,
  };
  const b = dragBounds(drag, { x: 3200, y: 400 });
  assert.ok(b.x >= 1920, 'x moved onto the right-hand display, got ' + b.x);
});

check('resizing holds the aspect ratio', () => {
  const resize = {
    kind: 'resize',
    origin: { x: 1200, y: 700 },
    startBounds: { x: 400, y: 200, width: 800, height: 450 },
  };
  const b = resizeBounds(resize, { x: 1400, y: 700 }, 16 / 9);
  assert.strictEqual(b.width, 1000);
  assert.ok(Math.abs(b.width / b.height - 16 / 9) < 0.01, 'aspect held');
  assert.strictEqual(b.x, 400, 'the top-left corner stays put');
});

check('a window cannot be shrunk into nothing', () => {
  const resize = {
    kind: 'resize',
    origin: { x: 1200, y: 700 },
    startBounds: { x: 400, y: 200, width: 800, height: 450 },
  };
  const b = resizeBounds(resize, { x: -4000, y: -4000 }, 16 / 9);
  assert.ok(b.width >= MIN_WIDTH, 'width floor respected, got ' + b.width);
});

check('a window dropped off the edge stays reachable', () => {
  const b = clampToDisplay({ x: -3000, y: -900, width: 900, height: 506 }, left);
  assert.ok(b.x + b.width > left.workArea.x, 'some of it is still on screen');
  assert.ok(b.y >= left.workArea.y, 'the title bar is never above the screen');
});

check('a window dropped on the second monitor is clamped to that monitor', () => {
  const b = clampToDisplay({ x: 4400, y: 1300, width: 900, height: 506 }, right);
  assert.ok(b.x < right.workArea.x + right.workArea.width, 'pulled back on screen');
  assert.ok(b.y + b.height / 3 <= right.workArea.y + right.workArea.height, 'grabbable');
});

console.log('\npassed ' + passed + ' of ' + total);
