import {
  DEFAULT_TARGET_FRAME_RATE,
  isTargetFrameRate,
  type TargetFrameRate,
} from './contracts.js';

/** Shared repair budget for desktop and hosted game production. */
export const MAX_GAME_HARNESS_REPAIR_ATTEMPTS = 3;

export function buildExperiencePlaytestContract(): string {
  return `<experience_playtest_contract schema_version="1">
The Planner MUST define one shortest complete player journey in its plan. The ordered path must cover launch/ready,
start, visible movement or navigation, the game's primary action, positive progress feedback, a representative
failure or invalid-action response, pause and resume, a terminal success or failure state, and restart back to a
playable state. Name the exact input and observable result for every step. A source-file checklist is not a journey.

The Implementer MUST create or update \`.ludoready/playtest.json\` after every change to controls, entrypoint, rules, UI,
or game state. The file must be valid UTF-8 JSON with this bounded schema (unknown executable fields are forbidden):
{
  "schemaVersion": 1,
  "updatedAt": "ISO-8601 timestamp",
  "engine": "web|godot",
  "entrypoint": { "path": "project-relative production HTML", "readyTimeoutMs": 1000..30000 },
  "actions": {
    "start":   { "inputs": [PlaytestInput...] },
    "move":    { "inputs": [PlaytestInput...] },
    "primary": { "inputs": [PlaytestInput...] },
    "pause":   { "inputs": [PlaytestInput...] },
    "restart": { "inputs": [PlaytestInput...] }
  },
  "journey": [{
    "id": "stable-unique-id",
    "action": "launch|start|move|primary|pause|restart|wait",
    "inputs": [PlaytestInput...],
    "sustain": [{ "code": "KeyboardEvent.code", "intervalMs": 100..5000 }],
    "observe": [{ "kind": "canvas-not-blank|screen-change|text-visible|text-hidden|element-visible", "description": "player-visible expected result", "value": "optional expected text or safe selector", "baselineStepId": "required for screen-change" }],
    "capture": "safe-name.png"
  }],
  "success": [{ "kind": "canvas-not-blank|screen-change|text-visible|text-hidden|element-visible", "description": "observable completion, failure-feedback, or restarted-playable condition", "value": "optional expected text or safe selector", "baselineStepId": "optional prior step" }],
  "limits": { "maxRunMs": 5000..180000, "stepTimeoutMs": 250..30000 }
}
PlaytestInput is exactly one of {"type":"key","code":"KeyboardEvent.code","holdMs":0..5000},
{"type":"pointer","xRatio":0..1,"yRatio":0..1,"button":0|1|2},
{"type":"look","deltaX":-1000..1000,"deltaY":-1000..1000,"durationMs":16..2000},
{"type":"drag","fromXRatio":0..1,"fromYRatio":0..1,"toXRatio":0..1,"toYRatio":0..1,"button":0|1|2,"durationMs":16..3000},
or {"type":"wait","ms":0..10000}. Use look for first/third-person camera motion and drag for card, inventory,
map, aiming, or touch-like gestures; do not approximate either with a single click.
sustain is optional (empty by default), max two different safe keys. It sends real periodic key presses throughout a step including captures; use it only for active games needing repeated input, never a paused or terminal step, and do not also hold that key in inputs. It stops on step completion/abort. text-hidden must reference a previous baselineStepId whose text-visible observation for the same value actually passed; it proves that real overlay disappeared, never a fabricated state. Choose the real input cadence from production physics. Screenshots/DOM checks take wall time while gameplay keeps running. Ready/menu and terminal screens should remain stable for legibility; discrete actions require separate presses, not a long hold called repeated input.
Use project-relative paths and stable IDs. Do not include JavaScript expressions, shell commands, URLs, absolute
paths, secrets, selectors that escape the game document, or instructions to access files outside the workspace.
Each common action must map to real production input; a move-only game may make primary a contextual interact input,
but it may not omit the primary-action check. Pause must visibly freeze gameplay and resume it; restart must restore a
fresh playable state without reloading the desktop app. Keep the journey bounded and deterministic enough to replay.

Only the PlayReady host owns \`artifacts/playtest/\`. The Implementer MUST NOT create, edit, copy, or fabricate
\`artifacts/playtest/latest/report.json\` or screenshots. A host report, when present, must use the same playtest
schema version, identify the tested entrypoint and journey step IDs, and give each step a passed/failed status,
observations, console/runtime errors, duration, and a project-relative screenshot path under
\`artifacts/playtest/latest/screenshots/\`.

The Reviewer MUST inspect the production control handlers and the declared journey rather than trusting summaries.
It must verify launch, player control, primary-action feedback, failure/invalid feedback, pause/resume, terminal state,
and restart as one coherent loop. When the host report exists, inspect the JSON plus referenced captures and return
"repair" for a non-passed/stale report, missing required step, timeout, console/runtime error, blank capture, absent
capture, implausibly unchanged before/after frames, entrypoint mismatch, or claims contradicted by screenshots. When
the report clearly predates the current Implementer changes, treat it as prior failure evidence, verify the repair in
the workspace, and leave the host rerun pending; never block that rerun solely on the old verdict. When host artifacts
are absent during the pre-host Reviewer pass, explicitly leave host playtest validation pending and
require other actual runnable evidence; code presence, a README claim, or an Implementer statement alone is never
proof that the game can be played.
</experience_playtest_contract>`;
}

export function buildVisualAssetCoverageContract(): string {
  return `<visual_asset_coverage_contract>
The generated-image gate proves that at least one trusted image exists; it does NOT prove that the game's core visual subjects are covered. The Planner MUST add a core visual asset table that lists every player-visible interactive subject family, its stable subject/card/entity IDs, required states, chosen asset path or atlas regions, and exact runtime binding code. Backgrounds, splash art, logos, and decorative frames are separate roles and never cover missing gameplay entities.
Default to producing real visual assets through the host image route when suitable, coherent assets are not already present. Do not ask the user to choose a generation strategy. Reuse is allowed only after inspecting usable existing art and its production binding. Every generated/imported asset must be registered in public/assets/asset-pack.json with classification metadata such as role and subjectId; an atlas must use role=card-art-atlas plus columns, rows, and a comma-separated subjects list. Classification metadata is not origin proof and cannot replace the private generated-image attestation.
For card, deck-building, board, and tactics games, each distinct playable card/piece family needs addressable art. Separate card-face assets must use unique subjectId values. A shared atlas is acceptable only when it contains at least four genuinely distinct, predictable regions, identifies every covered cardId/subject, and production code selects the correct region for each card. A table background, one repeated picture, the complete uncropped sheet, plain text on default Buttons, or color-only rectangles are not card-art coverage.
For character/action games, cover the player, representative enemies, interactable objects, pickups/projectiles, and gameplay feedback required by the vertical slice. Programmatic geometry can support an intentionally abstract visual language, but it cannot silently replace requested depicted characters or props. UI labels may be code-native; the depicted gameplay subject underneath must still be visually represented.
The Implementer MUST wire core assets into the running game and report the actual subjectId-to-path/atlas-region mapping. The Reviewer MUST inspect the manifest, source/scene bindings, and running presentation. Return repair for missing subject families, duplicate regions masquerading as variety, manifest-only assets, an atlas rendered without region selection, fallback primitives replacing requested art, or core entities still displayed as plain text/default controls. The host may apply an additional deterministic genre gate after review; failing it blocks completion even if one background passed the general image gate.
</visual_asset_coverage_contract>`;
}

export function buildAnimationNeedsContract(): string {
  return `<animation_needs_contract>
The Planner MUST perform an animation needs assessment on every run, even for a focused iteration. The written plan must contain exactly one block in this form:
<animation_needs_assessment generation="generate|reuse|not-needed" presentation="2d|2.5d|3d">
- rationale: why this generation state and presentation type fit the playable result
- subjects_and_states: animated subjects and gameplay states or "none"
- evidence: exact existing asset and playback-code paths for reuse, the concrete asset gap for generate, or "none" for not-needed
- production_path: generated frame/sheet or GLB-clip plan, verified reuse path, or programmatic motion/feedback plan
- interaction_motion: core state changes and their visible transitions (input, move/deal, primary action, hit/result)
- runtime_evidence: how tests or a running capture prove an intermediate state, not only the final state
</animation_needs_assessment>
Assess two independent layers: (1) pose/form animation such as idle, walk, run, jump, flap, attack, hit, death, reload, cast, or transformation; and (2) interaction motion that communicates gameplay state changes. The generate/reuse/not-needed choice applies to pose/form assets, but interaction motion is mandatory for an interactive game even when pose generation is not needed. Then inspect the actual workspace before choosing a generation state. For presentation="2d" or "2.5d", use ImageGen keyframes or a sprite sheet. For presentation="3d", use a real animation clip on an actual rigged GLB mesh; ImageGen may supply reference art or a billboard alternative, but it cannot create or prove a rigged 3D animation clip.
Choose generation="generate" only when pose/form animation is needed and suitable animation assets are absent, invalid, inconsistent, unused, missing a required state, or made obsolete by this run's art direction, scale, frame dimensions, anchor, or view/camera changes. For 2D/2.5D, the Implementer MUST use ludoready_image_generate for each required consistent output and follow its Codex ImageGen fallback instruction when no image API is available, creating at least two usable, distinct keyframes or one sprite sheet. Lock subject design, art style, palette, lighting, scale, frame dimensions, anchor, and view/camera angle; define frame order and timing; ingest/register the output under public/assets; and implement actual frame selection or sprite-sheet cropping. For actual 3D, integrate a self-contained rigged GLB with a real animation clip and play that clip; generated images are only reference or an explicitly chosen billboard path, never a substitute for the clip. If a required 3D clip cannot be supplied, report a blocker rather than fabricating success.
Choose generation="reuse" only after verifying that the workspace already contains at least two genuinely different usable 2D/2.5D frames or a sprite sheet with multiple pose regions, or an actual rigged GLB containing the required animation clip. Cite exact project-relative asset paths and the production playback code. The Implementer must preserve or complete real frame/clip playback and must not call an image generator merely to recreate an already suitable animation asset. Reuse does not waive the separate required_image_generation host contract, which may independently require a qualifying host-generated image. If the cited asset, poses, clip, or playback cannot be verified, change the assessment to generate and document why.
Choose generation="not-needed" only when pose/form changes would not improve the requested result, for example a static board, menu, background, logo, rigid prop, or abstract object fully communicated by transforms, particles, camera motion, or UI transitions. The plan and implementation report MUST state the concrete reason. Not-needed never means interaction_motion="none" for an interactive game. The Implementer must still add visible time-based transitions tied to input and state: at minimum entry/move, the primary action, hit/invalid-action feedback, and result/turn feedback where those states exist. For a card game this means observable deal/draw, hover/focus, play-to-board, attack/target, hit/damage, death/discard, and turn/result transitions. Reduced-motion may shorten or simplify them but cannot remove state clarity.
A synchronous AI/action loop that mutates every state in one rendered frame is not animated. Rebuilding and destroying every entity node on each refresh is also insufficient when it prevents continuity. Sequence automated actions with bounded awaits/tweens, preserve or ghost the moving visual long enough to show an intermediate state, and keep input locked during the sequence.
A moving static image is not 2D keyframe animation, rendering a full sheet without cropping is not sprite animation, and rotating or translating a mesh does not prove a 3D animation clip. The Implementer must challenge missing or implausible Planner evidence. If the Planner block is absent, inspect the workspace, record a recovered three-state assessment in GAME_DESIGN.md, and follow it; never silently default to generation. When reuse cannot be proven, the safe animation-producing fallback is generate.
The Reviewer MUST verify the assessment against the user request and actual workspace rather than trusting the summaries. For generate, verify the stated asset gap, new consistent frame assets or real GLB clip, production references, and code that advances frames or plays the clip. For reuse, verify the exact cited assets contain at least two distinct poses or the required GLB clip and that production code actually plays them. For not-needed, verify the rationale and every required interaction transition. Inspect a smoke test, captured frames, or runtime state that proves at least one intermediate position/scale/frame and the final state; merely finding the word Tween/AnimationPlayer is not proof. Return "repair" for a missing or incorrect state, unjustified regeneration, unproven reuse, inconsistent or unused frames, a static sheet/single frame, a non-playing GLB clip, same-frame automated actions, destructive rebuilds that erase transitions, or absent motion feedback. A repair pass must record a recovered assessment in GAME_DESIGN.md and fully satisfy its branch before re-review can pass.
</animation_needs_contract>`;
}

export function buildTargetFrameRateContract(
  targetFrameRate: TargetFrameRate = DEFAULT_TARGET_FRAME_RATE,
): string {
  if (!isTargetFrameRate(targetFrameRate)) {
    throw new Error('targetFrameRate must be 30, 60, or 120');
  }
  return `<target_frame_rate_contract fps="${targetFrameRate}">
This is the host-selected production target for this run. It applies to the Planner, Implementer, Reviewer, repair pass, and re-review. Do not silently substitute another target.
The Planner MUST identify the engine timing code and every animation asset/variant affected by ${targetFrameRate} FPS. The plan must specify a deterministic fixed-step or equivalent time-based simulation cadence, the presentation cadence, animation durations, source sample/keyframe density, asset metadata, runtime variant selection, and checks that distinguish simulation rate from display refresh limits.
The Implementer MUST make the running game target ${targetFrameRate} updates/frames per second where the engine and display permit. Use elapsed time or a bounded fixed-step accumulator so gameplay speed, collision, input, cooldowns, particles, audio cues, and animation duration stay deterministic and do not speed up or slow down when the physical display refresh differs. A 120 FPS target may execute two 120 Hz simulation steps on a 60 Hz display while presentation remains display-limited; never claim the display rendered 120 distinct frames without measurement. Cap catch-up work to prevent a background-tab spiral.
Generated or reused animation assets MUST be authored, sampled, tagged, and selected for this ${targetFrameRate} FPS target. Record enough manifest or adjacent metadata to verify at least targetFps=${targetFrameRate}, sourceAnimationFps, frameCount, durationMs, timingMode, and a stable variant/group identifier. Production code must select a matching ${targetFrameRate} FPS variant, or explicitly select a shared compatible asset whose metadata and measured playback prove compatibility at ${targetFrameRate} FPS. Never choose a stale variant merely because its file exists.
Target FPS is not the same as bitmap count. Do NOT generate 30, 60, or 120 unique bitmap frames per second by default. Choose source keyframe density from motion/style needs, keep exact durations, and use deterministic frame holds, interpolation, skeletal animation, morph targets, or engine sampling to preserve motion quality at ${targetFrameRate} FPS. For example, a deliberately authored 12-sample walk may render on a 60 FPS timeline when its metadata and time-based playback preserve its intended duration; ${targetFrameRate} duplicated images are not extra animation quality.
If the project previously targeted another FPS, treat old target-specific animation variants, timing constants, exports, and caches as stale until inspected. Update, regenerate, resample, retag, or reselect the affected assets and playback code; remove production references to the incompatible variant. A shared asset may remain only with explicit compatibility metadata and verification at ${targetFrameRate} FPS. Persist the selected target and animation timing/variant decision in GAME_DESIGN.md or equivalent project documentation.
The Reviewer MUST inspect actual timing code, asset metadata, and runtime selection. Return "repair" for a hard-coded stale FPS, frame-count-based gameplay speed, mismatched or untagged target-specific assets, selection of the wrong variant, changed FPS without an asset/playback audit, excessive catch-up, duplicated frames presented as quality, or claims of ${targetFrameRate} FPS without proportionate verification. The repair pass must replace/reselect stale variants and timing code before re-review can pass.
</target_frame_rate_contract>`;
}

