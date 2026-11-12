/**
 * boot.ts — запуск «Свадебной Диаблы» на 2D-canvas.
 * Контракт с оболочкой (src/pages/Home.tsx): startGame(canvas) / stopGame().
 * window.__gameProbe и window.__GAME_READY__ сохранены для scripts/verify-game.mjs:
 * Space на экране выбора запускает забег, W двигает героя вверх (+z), D — вправо (+x).
 */

import { Arpg } from "./arpg";

declare global {
  interface Window {
    __gameProbe?: () => { x: number; y: number; z: number };
    __GAME_READY__?: boolean;
  }
}

let session: { dispose: () => void } | null = null;

export function startGame(canvas: HTMLCanvasElement): void {
  stopGame();

  const game = new Arpg(canvas);
  game.start();

  window.__gameProbe = () => game.probe();
  (window as unknown as { __gameState?: () => string }).__gameState = () => game.stateName;
  (window as unknown as { __perf?: () => { update: number; render: number; frames: number } }).__perf = () => game.perfStats();
  (window as unknown as { __netInfo?: () => unknown }).__netInfo = () => game.netInfo();
  (window as unknown as { __debug?: Record<string, () => void> }).__debug = {
    boss: () => game.debugBoss(),
    heal: () => game.debugHeal(),
  };
  // первый отрисованный кадр — страница играбельна
  const markReady = () => {
    window.__GAME_READY__ = true;
  };
  requestAnimationFrame(markReady);

  session = {
    dispose: () => {
      game.dispose();
      delete window.__gameProbe;
      window.__GAME_READY__ = false;
    },
  };
}

export function stopGame(): void {
  session?.dispose();
  session = null;
}
