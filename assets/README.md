# public/assets

Static files served as-is at `/assets/...`.

| Folder     | Contents                                                                 |
|------------|--------------------------------------------------------------------------|
| `models/`  | Opponent GLB (any standard humanoid rig; bone names mapped in `src/opponent/OpponentConfig.ts`) and an optional face-region mask PNG (red = region code × 16, see the main README) |
| `textures/`| Optional hand-made textures (masks, splat sprites)                      |
| `sounds/`  | Impact, vocalisation and ambience audio                                 |

Nothing here is required: every system has a procedural fallback (gym
textures, fist models, and — from Milestone 2 — a procedural humanoid).
