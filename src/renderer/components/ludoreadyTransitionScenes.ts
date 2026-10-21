import cozyWorkshopGif from '../assets/ludoready-transition-scenes/ludoready-cozy-workshop.gif';
import crystalLabGif from '../assets/ludoready-transition-scenes/ludoready-crystal-lab.gif';
import forestCampGif from '../assets/ludoready-transition-scenes/ludoready-forest-camp.gif';
import potionGardenGif from '../assets/ludoready-transition-scenes/ludoready-potion-garden.gif';
import rooftopStudioGif from '../assets/ludoready-transition-scenes/ludoready-rooftop-studio.gif';
import seasideArcadeGif from '../assets/ludoready-transition-scenes/ludoready-seaside-arcade.gif';
import skyDockGif from '../assets/ludoready-transition-scenes/ludoready-sky-dock.gif';
import snowCabinGif from '../assets/ludoready-transition-scenes/ludoready-snow-cabin.gif';
import starObservatoryGif from '../assets/ludoready-transition-scenes/ludoready-star-observatory.gif';

export const LUDOREADY_TRANSITION_SCENES = [
  cozyWorkshopGif,
  crystalLabGif,
  forestCampGif,
  skyDockGif,
  seasideArcadeGif,
  snowCabinGif,
  starObservatoryGif,
  potionGardenGif,
  rooftopStudioGif,
] as const;

export const LUDOREADY_TRANSITION_SCENE_COUNT = LUDOREADY_TRANSITION_SCENES.length;

export function ludoreadyTransitionSceneIndex(runId: number): number {
  if (!Number.isFinite(runId) || runId <= 1) return 0;
  return (Math.floor(runId) - 1) % LUDOREADY_TRANSITION_SCENE_COUNT;
}

export function ludoreadyTransitionSceneForRun(runId: number): string {
  return LUDOREADY_TRANSITION_SCENES[ludoreadyTransitionSceneIndex(runId)];
}
