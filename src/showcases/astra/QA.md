# Verification — 2026-09-22 / 23

- `npm test`: 2 kinematics checks pass. Full pedal revolution on both sides remains reachable with fixed upper/lower segment lengths. Pedals remain opposite and on their crank circle.
- `npm run build`: passes. Vite reports the expected >500 kB Three.js bundle warning (about 141 kB gzip for the main bundle); this is not a build failure.
- Chrome / Computer Use: rendered at 1920×928 and 390×844. No document horizontal overflow; controls fit both sizes. Coast, Studio, Day, Sunset, Night, Cruise, Sprint and pause/resume were exercised in the live UI. Orbit was activated and the camera moved.
- Visual repairs: pulled the coast camera back so the water base fits; fixed night text contrast; made the studio rim follow its oval base; raised and widened the studio camera framing to include the entire pelican.
- The official ToanKhonTech brand files were copied without modification and compared to the rendered header.
- Browser log observations: no application errors. Browser extension content-script warnings were present and are unrelated to this demo.
- Reduced-motion preference starts the scene paused. Explicit time seeking is available for geometry; live camera and light transitions are stateful.

## Limits

This is stylized procedural art with a kinematic pedal mechanism, not a dynamics simulation. The bird stays centered while lane marks move. Water is a lightweight decorative shader. No claim about a model benchmark score, generation latency or one-shot performance is made. Mobile coast view is deliberately pulled back to fit the diorama; Studio gives a larger view of the rider.

## Release and video

- GitHub repository visibility verified PUBLIC. Pages build completed successfully; each of the five deployed app files matched the local production build byte-for-byte. Public Studio and Night controls were exercised in Chrome.
- Final video: 23.533333 seconds, 1920×928, H.264/yuv420p, 30 fps, silent. Real Chrome tab recording through Computer Use/CDP; no speed change. Viewed representative frames and played the final MP4 to completion without a media error.
