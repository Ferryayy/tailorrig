(function renderAnimationGridImmediately() {
  "use strict";

  const animationRoot = "./source/anim/run_anim_texture_glb_gp";
  const methods = [
    { directory: "gt", label: "Ground Truth" },
    { directory: "ours", label: "Ours" },
    { directory: "mia", label: "MIA" },
    { directory: "unirig", label: "UniRig" },
    { directory: "pinocchio", label: "Pinocchio" },
  ];
  const samples = [
    { file: "514_WD.glb" },
    { file: "Arissa_TG_update.glb" },
    { file: "fox_TG.glb", missing: ["mia"] },
    { file: "peasant_run.glb" },
  ];

  function hasResult(sample, methodDirectory) {
    return !sample.missing?.includes(methodDirectory);
  }

  function createCard(sample, method) {
    const card = document.createElement("article");
    const resultExists = hasResult(sample, method.directory);
    card.className = resultExists
      ? "model-card rig-viewer animation-card is-loading"
      : "model-card animation-card animation-card--empty";

    if (resultExists) {
      card.dataset.model = `${animationRoot}/${method.directory}/${sample.file}`;
      card.dataset.animation = "true";
      card.setAttribute("aria-busy", "true");
    }

    const header = document.createElement("header");
    header.className = "model-card-header";
    const heading = document.createElement("h3");
    heading.textContent = method.label;
    header.append(heading);
    card.append(header);

    const stage = document.createElement("div");
    stage.className = "viewer-stage animation-stage";

    if (resultExists) {
      const canvas = document.createElement("canvas");
      canvas.className = "rig-canvas";
      canvas.setAttribute("aria-label", `Interactive ${method.label} animation`);
      const status = document.createElement("div");
      status.className = "viewer-status";
      status.setAttribute("role", "status");
      status.textContent = "Loading animation…";
      stage.append(canvas, status);
    } else {
      stage.setAttribute("aria-hidden", "true");
    }
    card.append(stage);

    const controls = document.createElement("div");
    controls.className = "viewer-controls";
    if (resultExists) {
      controls.setAttribute("aria-label", `${method.label} animation display modes`);
      controls.innerHTML = `
        <button class="viewer-mode is-active" type="button" data-mode="mesh" aria-pressed="true" disabled>Mesh</button>
        <span class="bone-mode-buttons"></span>
        <button class="viewer-mode" type="button" data-mode="weights" aria-pressed="false" disabled>Weights</button>
      `;
    } else {
      controls.setAttribute("aria-hidden", "true");
    }
    card.append(controls);

    const instructions = document.createElement("p");
    instructions.className = "model-instructions";
    if (resultExists) {
      instructions.innerHTML = `
        <span aria-hidden="true"><i class="fa-solid fa-arrows-rotate"></i></span>
        Drag · Scroll to zoom
      `;
    } else {
      instructions.setAttribute("aria-hidden", "true");
      instructions.innerHTML = "&nbsp;";
    }
    card.append(instructions);

    return card;
  }

  const grid = document.querySelector("#animation-grid");
  if (!grid) {
    return;
  }

  const cards = document.createDocumentFragment();
  samples.forEach((sample) => {
    methods.forEach((method) => cards.append(createCard(sample, method)));
  });
  grid.replaceChildren(cards);
})();
