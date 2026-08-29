# TailorRig Project Page

Minimal local project page for:

> TailorRig: Controllable and Structured Auxiliary Skeleton Generation for Garment-Aware Rigging

The page is adapted from the [Nerfies project page](https://github.com/nerfies/nerfies.github.io) and keeps the original template attribution in the footer.

## Local preview

No build step or package installation is required.

From this folder, run:

```bash
python3 -m http.server 8000
```

Then open [http://localhost:8000](http://localhost:8000).

## Current scope

- Text-focused MVP
- Paper metadata and author list
- Paper, Appendix, Code, Data, and Model link placeholders plus an in-page Video link
- Six interactive GLB previews in a desktop 3 × 2 grid
- Mesh, semantic skeleton groups, and full-body weight-color modes
- Automatic `Tex` mode for GLB files that contain one or more texture maps
- Two continuously looping animation previews loaded from `source/anim/`, with the same mesh, semantic skeleton, and weight modes
- Bounding-box camera fitting that accounts for the viewer aspect ratio
- Crease-aware normal smoothing and shadow-bias correction for split-normal GLB exports
- Abstract
- Placeholder BibTeX
- Official SIGGRAPH Asia logo and an inline local video

## Resource buttons

The six resource buttons are visually active but intentionally do nothing until a URL is provided. To enable one later, edit its `data-url` value in `index.html`:

```html
<button class="... reserved-link" data-url="https://example.com/paper.pdf">Paper</button>
```

Use a section anchor such as `data-url="#video"` when a button should scroll to content on the same page.

## 3D model preview

The page loads `source/model1.glb` through `source/model6.glb` with a custom Three.js viewer. The existing static HTML framework is unchanged and remains compatible with GitHub Pages.

Each card starts in Mesh mode:

- Every model uses the same opaque neutral clay material in the viewer (color `#b8bec8`, metalness `0`, roughness `0.82`). The source GLB files are not modified.
- Coincident split vertices are smoothed at runtime when their exported normals fall within the crease threshold, which reduces faceted or rippled shading while preserving intentional hard edges.
- The initial camera distance is calculated from all eight bounding-box corners, the camera field of view, and the live canvas aspect ratio so each character starts fully framed.
- Semantic bone buttons are generated from bone names after the GLB loads.
- A `Tex` button is generated immediately after `Mesh` only when the loaded GLB's original material references a texture. Texture-less models do not show the button.
- Bone-name matching is case-insensitive substring matching.
- Bones that match no semantic keyword are grouped under Body.
- Bone groups are overlaid on the original Mesh as sphere joints and cylinder segments. Each semantic group uses one fixed color.
- Clicking the active bone button again removes the overlay and returns to Mesh only.
- Weights blends each vertex from the stable colors of its influencing bones.

Edit `BONE_KEYWORDS` near the top of `static/js/viewer.js` when the final semantic dictionary is ready:

```js
const BONE_KEYWORDS = ["skirt", "hair", "sleeve", "cape", "accessory"];
```

To replace or extend the examples, update the `data-model` paths in `index.html`.

Animation cards use the same `RigViewer` implementation as the static cards. Add `data-animation="true"` to the card and point `data-model` to a GLB containing an animation clip; the first clip plays continuously in a loop.

## Inline video

The current page plays `source/video/video1.mp4` directly above the Abstract. For another inline video, place an H.264/AAC MP4 file under `source/` and use a native video element:

```html
<section class="section" id="video">
  <div class="container is-max-desktop">
    <video controls playsinline preload="metadata" poster="./source/video-poster.jpg">
      <source src="./source/demo.mp4" type="video/mp4">
      Your browser does not support HTML video.
    </video>
  </div>
</section>
```

The `controls` attribute adds playback controls, `playsinline` keeps playback inside the page on mobile, and `preload="metadata"` avoids downloading the entire video before the user presses play.

## Website license

The original Nerfies website template is licensed under the [Creative Commons Attribution-ShareAlike 4.0 International License](https://creativecommons.org/licenses/by-sa/4.0/).
