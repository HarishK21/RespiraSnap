# RespiraSnap Landing (Next.js + R3F)

Premium App Router landing page with a GLB-based 3D hero scene, cinematic bloom, haze, and minimal UI for a single mode: **Breathing Snapshot**.

## Tech stack

- Next.js (App Router, TypeScript)
- React Three Fiber (`@react-three/fiber`)
- Drei (`@react-three/drei`)
- Postprocessing (`@react-three/postprocessing`)

## Run locally

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

`npm run dev` now auto-cleans stale `.next` output before startup to avoid chunk mismatch errors.

## Included routes

- `/`:
  - Fullscreen WebGL landing scene using `neuronal_cell_environment.glb` as the hero object
  - Minimal overlay UI
  - Click model part (or CTA) to trigger cinematic zoom transition to recording mode
  - Reduced motion toggle
  - WebGL fallback gradient when unavailable
  - If GLB fails to load, scene shows: "Model failed to load" with the attempted model path
- `/record?mode=breathing`:
  - Placeholder recording screen that reads `mode` query param
  - "Recording flow coming soon" UI

## Model path

The hero model must exist at:

`public/models/neuronal_cell_environment.glb`

The scene loads this via `useGLTF("/models/neuronal_cell_environment.glb")`.

## Performance notes

- GLB hero model loaded from local `public/models`
- Subtle atmosphere particles/haze and single-scene postprocessing chain
- DPR clamped (`[1, 1.75]`) for laptop smoothness

## Troubleshooting

If you hit:

`Error: Cannot find module './819.js'` (or similar chunk file in `.next/server/webpack-runtime.js`)

run:

```bash
npm run clean
npm run dev
```
