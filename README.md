# IMPACT — WebXR VR striking simulator

Browser-based VR boxing / striking game for Meta Quest 2/3/Pro (Quest Browser)
and PC VR via WebXR. Built with TypeScript, Vite, Three.js and Rapier.

## Quick start

```bash
npm install
npm run dev        # HTTPS dev server (self-signed cert) on https://localhost:5173
```

Other scripts:

| Script              | What it does                                                    |
|---------------------|-----------------------------------------------------------------|
| `npm run dev`       | HTTPS dev server on all interfaces (for Quest over Wi-Fi)       |
| `npm run dev:http`  | Plain-HTTP dev server (localhost only is a secure context)      |
| `npm run typecheck` | Strict TypeScript check                                         |
| `npm run build`     | Type-check + production build into `dist/`                      |
| `npm run preview`   | Serve the production build (HTTPS)                              |

URL flags: `?debug=1` / `?debug=0` show or hide the performance HUD at startup
(on by default in dev), `?quality=quest2|quest3|pc` forces a quality preset
(otherwise auto-detected from the user agent), `?model=/assets/models/x.glb`
loads a custom opponent (see below), `?ko=getup` makes a knocked-out opponent
stand back up on his own instead of waiting for a reset.

## Testing on a Quest

WebXR requires a secure context (HTTPS, or `localhost`).

### Over Wi-Fi (no cable)

1. Put the PC and the headset on the same network.
2. Run `npm run dev`. Vite prints a **Network** URL such as `https://192.168.1.23:5173`.
3. If Windows Firewall asks, allow Node.js on **private** networks (otherwise the
   headset cannot connect).
4. In Quest Browser open that URL. You'll get a certificate warning because the
   cert is self-signed: choose **Advanced → Proceed**. You only need to do this once
   per dev-server certificate.
5. Press **Enter VR**.

### Over USB (no certificate warning)

1. Enable developer mode on the headset and connect it with USB (`adb devices` should list it).
2. `adb reverse tcp:5173 tcp:5173`
3. `npm run dev:http`, then open `http://localhost:5173` in Quest Browser.

### Without a headset

Desktop mode works in any WebGL2 browser. To exercise the XR code paths without
hardware, install Meta's *Immersive Web Emulator* browser extension, which
emulates a Quest headset, controllers and hands.

## Controls

| Action                | Desktop           | VR                                           |
|-----------------------|-------------------|----------------------------------------------|
| Punch                 | Click on the opponent (hands alternate; speed slider in the panel) | Punch with the controllers, or with closed fists when hand tracking (open hand = slap) |
| Reset after knockout  | `O`               | `A` (right controller)                       |
| Look                  | Drag with mouse   | Head tracking                                |
| Move                  | `W` `A` `S` `D`   | Walk in your play space                      |
| Recenter              | `R`               | Click either thumbstick (or the Meta-button recenter) |
| Performance HUD       | `H`               | `Y` (left controller)                        |
| Hitboxes & damage zones | `B`, then hover the mouse over the opponent | `X` (left), then point the right controller |
| Reset opponent        | `O`               | (wrist menu, Milestone 9)                    |

Controllers are shown as bare fists. Put the controllers down and Quest switches
to hand tracking automatically; the tracked hands are shown instead.

With hitboxes on, the body is tinted by damage zone, the physics colliders are
drawn as wireframes, and the HUD's **Probe** line shows the zone, collider and
UV under the pointer (face regions come from the UV lookup).

## The opponent

By default the opponent is generated procedurally: a 1.8 m boxer with a full
humanoid skeleton (hips, 3 spine bones, neck, head, jaw, eyes, eyelids,
shoulders, arms, hands, legs, feet), a parametric head with a face texture,
and a UV atlas laid out so the whole body can later receive bruise and blood
paint. He idles in an orthodox guard with IK-planted feet, breathes, shifts
his weight, blinks and tracks your head with his eyes.

### Using your own model

1. Put a rigged humanoid GLB (Mixamo, Ready Player Me, Unreal mannequin or VRM
   naming) in `public/assets/models/`.
2. Open the game with `?model=/assets/models/your-model.glb`, or set
   `modelUrl` in [src/opponent/OpponentConfig.ts](src/opponent/OpponentConfig.ts).
   Other rigs can be mapped by adding their bone names to `boneAliases` there.
3. Optional: provide a face-region mask PNG in the model's UV space
   (`?faceMask=...` or `faceRegionMaskUrl`). Red channel = region code × 16:
   1 head, 2 nose, 3 left eye, 4 right eye, 5 brow, 6 left cheek, 7 right cheek,
   8 mouth, 9 jaw. Without a mask, face regions are classified from the hit
   position around the head bone.

If the model fails to load, the procedural opponent is used and a warning is
logged.

## Punching

- Each fist is a 3.6 cm strike sphere swept from its previous position to its
  current one every frame, so fast punches can't pass through the guard.
- Impact speed is the hand velocity (smoothed over ~5 frames) along the
  surface normal: under 1 m/s is a touch; light < 3 ≤ medium < 5.5 ≤ heavy < 8 ≤
  devastating. Thresholds, the 120 ms per-fist cooldown and knockout rules
  are in [src/config.ts](src/config.ts) (`PUNCH`, `KNOCKOUT`).
- Punches are named jab / cross / hook / uppercut from their direction relative
  to your head.
- The opponent reacts physically: the struck bone and its parents get an
  angular impulse from the hit's lever arm and spring back to the animation;
  harder hits make him step back, buckle at the knees or drop his guard;
  stomach shots fold him forward. Enough head damage (jaw counts most), or
  one massive shot, knocks him out into a full Rapier ragdoll.
- Sounds are synthesised at startup (no audio files): impacts per tier and
  surface, grunts, a knockdown groan, breathing that gets heavier with
  damage, and gym ambience. Controllers vibrate in proportion to the hit.
- The HUD's **Last hit** line shows tier, punch type, zone, speed, damage and
  UV; **Damage** shows the knockout meter.

## Project layout

```
src/
  core/         App bootstrap, fixed-step loop, XR session, quality presets, physics world
  input/        XR controllers + hand tracking, velocity tracking, desktop controls
  player/       Player rig (recentering), procedural fists, per-hand state
  player/       ... plus fist colliders and the sweep-based punch detector
  opponent/     Rig contract, GLB loader + bone mapping, procedural humanoid, idle animation/IK,
                physics hitboxes, face-region lookup, hit reactions, knockout ragdoll
  damage/       Zone table, impact classification, damage/knockout model, hit pipeline
  audio/        Procedural sound synthesis and positional playback
  environment/  Gym + ring builder, procedural textures, lighting, static mesh batching
  debug/        Performance HUD, hit probe, shared debug counters
  ui/           2D landing overlay, floating world prompts
  config.ts     World layout, ring/room dimensions, physics step, URL flags
public/assets/  Optional models / textures / sounds (everything has a procedural fallback)
```

Later milestones add `blood/` and `skin/`.

## Milestones

- [x] **1. Setup**: Vite + TS + Three.js + WebXR, gym scene and lighting, controllers and hand tracking, desktop fallback
- [x] **2. Opponent**: procedural/GLB humanoid, idle animation, eye tracking, bone-attached hitboxes, debug visualisation
- [x] **3. Punching**: velocity tracking, swept collision, classification, haptics, audio, physical hit reactions, knockout ragdoll and reset
- [ ] 4. Gloves
- [ ] 5. Damage map
- [ ] 6. Blood core
- [ ] 7. Floor blood
- [ ] 8. Cuts, splatter, transfer
- [ ] 9. UI & settings
- [ ] 10. Polish & optimisation

## Notes

- The project lives in a OneDrive folder. `node_modules/` holds thousands of files;
  consider excluding it from sync (or moving the project) to avoid slow installs
  and file-lock errors.
- Rapier's `-compat` build inlines its WASM as base64 (~4 MB, ~1.7 MB gzipped). It is
  split into its own cached chunk.
