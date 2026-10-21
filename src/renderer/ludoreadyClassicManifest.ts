import ludoreadyCarrySprite from './assets/ludoready-sprite-carry.png';
import ludoreadyCelebrateSprite from './assets/ludoready-sprite-celebrate.png';
import ludoreadyIdleSprite from './assets/ludoready-sprite-idle.png';
import ludoreadyPaintSprite from './assets/ludoready-sprite-paint.png';
import ludoreadyPlaySprite from './assets/ludoready-sprite-play.png';
import ludoreadyRepairSprite from './assets/ludoready-sprite-repair.png';
import ludoreadySleepSprite from './assets/ludoready-sprite-sleep.png';
import ludoreadyWalkASprite from './assets/ludoready-sprite-walk-a.png';
import ludoreadyWalkBSprite from './assets/ludoready-sprite-walk-b.png';
import ludoreadyWorkSprite from './assets/ludoready-sprite-work.png';
import ludoreadyCoffeeASprite from './assets/ludoready-packs/classic/frames/sprite-coffee-a.png';
import ludoreadyCoffeeBSprite from './assets/ludoready-packs/classic/frames/sprite-coffee-b.png';
import ludoreadyInspectASprite from './assets/ludoready-packs/classic/frames/sprite-inspect-a.png';
import ludoreadyInspectBSprite from './assets/ludoready-packs/classic/frames/sprite-inspect-b.png';
import ludoreadyStretchASprite from './assets/ludoready-packs/classic/frames/sprite-stretch-a.png';
import ludoreadyStretchBSprite from './assets/ludoready-packs/classic/frames/sprite-stretch-b.png';
import ludoreadySweepASprite from './assets/ludoready-packs/classic/frames/sprite-sweep-a.png';
import ludoreadySweepBSprite from './assets/ludoready-packs/classic/frames/sprite-sweep-b.png';
import ludoreadyTypeASprite from './assets/ludoready-packs/classic/frames/sprite-type-a.png';
import ludoreadyTypeBSprite from './assets/ludoready-packs/classic/frames/sprite-type-b.png';
import type {
  LudoReadyAnimation,
  LudoReadyAnimationFrame,
  LudoReadySpriteManifest,
} from './ludoreadyAnimation';

const frame = (src: string, durationMs: number): LudoReadyAnimationFrame => ({ src, durationMs });

const singleFrame = (
  id: string,
  src: string,
  durationMs = 800,
): LudoReadyAnimation => ({
  id,
  frames: [frame(src, durationMs)],
  loop: true,
  restFrame: 0,
});

const alternatingFrames = (
  id: string,
  frameA: string,
  frameB: string,
  durationMs = 220,
): LudoReadyAnimation => ({
  id,
  frames: [
    frame(frameA, durationMs),
    frame(frameB, durationMs),
    frame(frameA, durationMs),
    frame(frameB, durationMs + 80),
  ],
  loop: true,
  restFrame: 0,
});

/**
 * Compatibility manifest for the original LudoReady sprite set.
 *
 * New character packs can replace this object with any number of authored
 * frames per pose. Keeping animation data outside the component means a pack
 * never needs pose-specific rendering code.
 */
export const CLASSIC_LUDOREADY_SPRITE_MANIFEST: LudoReadySpriteManifest = {
  schemaVersion: 1,
  id: 'classic-ludoready-v1',
  canvas: {
    width: 252,
    height: 336,
    pivot: { x: 126, y: 320 },
  },
  animations: {
    idle: singleFrame('classic-idle', ludoreadyIdleSprite),
    think: singleFrame('classic-think', ludoreadyIdleSprite),
    wait: singleFrame('classic-wait', ludoreadyIdleSprite),
    walk: {
      id: 'classic-walk',
      frames: [
        frame(ludoreadyWalkASprite, 150),
        frame(ludoreadyWalkBSprite, 150),
        frame(ludoreadyWalkASprite, 150),
        frame(ludoreadyWalkBSprite, 150),
      ],
      loop: true,
      restFrame: 0,
    },
    work: singleFrame('classic-work', ludoreadyWorkSprite),
    carry: singleFrame('classic-carry', ludoreadyCarrySprite),
    paint: singleFrame('classic-paint', ludoreadyPaintSprite),
    sleep: singleFrame('classic-sleep', ludoreadySleepSprite, 1_200),
    play: singleFrame('classic-play', ludoreadyPlaySprite),
    repair: singleFrame('classic-repair', ludoreadyRepairSprite),
    coffee: alternatingFrames('classic-coffee', ludoreadyCoffeeASprite, ludoreadyCoffeeBSprite, 360),
    stretch: alternatingFrames('classic-stretch', ludoreadyStretchASprite, ludoreadyStretchBSprite, 340),
    type: alternatingFrames('classic-type', ludoreadyTypeASprite, ludoreadyTypeBSprite, 150),
    inspect: alternatingFrames('classic-inspect', ludoreadyInspectASprite, ludoreadyInspectBSprite, 320),
    sweep: alternatingFrames('classic-sweep', ludoreadySweepASprite, ludoreadySweepBSprite, 240),
    celebrate: singleFrame('classic-celebrate', ludoreadyCelebrateSprite),
  },
};
