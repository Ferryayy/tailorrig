import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

// Edit this list when the final semantic bone dictionary is ready.
// Matching is case-insensitive substring matching; unmatched bones become Body.
const BONE_KEYWORDS = Object.freeze([
  "skirt",
  "hair",
  "sleeve",
  "cape",
  "accessory",
]);

const loader = new GLTFLoader();
const CLAY_COLOR = 0xb8bec8;
const CLAY_ROUGHNESS = 0.68;

const BONE_GROUP_COLORS = Object.freeze({
  body: 0x2f80ed,
  skirt: 0xf59e0b,
  hair: 0x8b5cf6,
  sleeve: 0x10b981,
  cape: 0xef476f,
  accessory: 0x14b8a6,
});
const DEFAULT_BONE_GROUP_COLOR = 0x64748b;
const JOINT_RADIUS = 0.027;
const BONE_RADIUS = 0.012;
const CYLINDER_UP_AXIS = new THREE.Vector3(0, 1, 0);

function titleCase(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function classifyBone(name) {
  const normalizedName = String(name || "").toLowerCase();
  return BONE_KEYWORDS.find((keyword) => normalizedName.includes(keyword)) || "body";
}

function colorForBone(name, fallbackIndex = 0) {
  const value = String(name || `bone-${fallbackIndex}`);
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  const hue = ((hash >>> 0) % 360) / 360;
  return new THREE.Color().setHSL(hue, 0.78, 0.56);
}

function colorForGroup(group) {
  return new THREE.Color(BONE_GROUP_COLORS[group] ?? DEFAULT_BONE_GROUP_COLOR);
}

function createClayMaterial() {
  return new THREE.MeshStandardMaterial({
    color: CLAY_COLOR,
    metalness: 0,
    roughness: CLAY_ROUGHNESS,
    side: THREE.DoubleSide,
    transparent: false,
    opacity: 1,
    depthWrite: true,
    vertexColors: false,
  });
}

class RigViewer {
  constructor(card) {
    this.card = card;
    this.modelUrl = card.dataset.model;
    this.stage = card.querySelector(".viewer-stage");
    this.canvas = card.querySelector(".rig-canvas");
    this.status = card.querySelector(".viewer-status");
    this.controlsElement = card.querySelector(".viewer-controls");
    this.boneButtonHost = card.querySelector(".bone-mode-buttons");

    this.mode = "mesh";
    this.activeGroup = null;
    this.model = null;
    this.ground = null;
    this.skeletonVisual = null;
    this.meshRecords = [];
    this.boneRecords = [];
    this.isVisible = true;
  }

  async init() {
    this.setupScene();
    this.setupObservers();
    this.setupControlEvents();

    try {
      const gltf = await loader.loadAsync(this.modelUrl);
      this.model = gltf.scene;
      this.scene.add(this.model);
      this.prepareModel();
      this.fitModelToStage();
      this.buildBoneButtons();
      this.enableControls();
      this.status.hidden = true;
    } catch (error) {
      console.error(`Unable to load ${this.modelUrl}`, error);
      this.status.textContent = "Unable to load this model.";
      this.status.classList.add("is-error");
    }
  }

  setupScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xf3f5f8);

    this.camera = new THREE.PerspectiveCamera(32, 1, 0.01, 100);
    this.camera.position.set(2.8, 1.25, 4.15);

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      canvas: this.canvas,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const hemisphereLight = new THREE.HemisphereLight(0xffffff, 0xaeb7c5, 2.2);
    this.scene.add(hemisphereLight);

    const keyLight = new THREE.DirectionalLight(0xffffff, 3.2);
    keyLight.position.set(3.5, 5, 4.5);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(1024, 1024);
    keyLight.shadow.camera.near = 0.1;
    keyLight.shadow.camera.far = 20;
    this.scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0xbfd6ff, 1.1);
    fillLight.position.set(-4, 2, -3);
    this.scene.add(fillLight);

    this.orbitControls = new OrbitControls(this.camera, this.canvas);
    this.orbitControls.enableDamping = true;
    this.orbitControls.dampingFactor = 0.055;
    this.orbitControls.enablePan = false;
    this.orbitControls.autoRotate = true;
    this.orbitControls.autoRotateSpeed = 0.65;
    this.orbitControls.minDistance = 2.2;
    this.orbitControls.maxDistance = 8;
    this.orbitControls.target.set(0, 0, 0);

    this.renderer.setAnimationLoop(() => {
      if (!this.isVisible) {
        return;
      }

      this.orbitControls.update();
      this.renderer.render(this.scene, this.camera);
    });
  }

  setupObservers() {
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.stage);

    this.visibilityObserver = new IntersectionObserver(
      ([entry]) => {
        this.isVisible = entry.isIntersecting;
      },
      { rootMargin: "180px" },
    );
    this.visibilityObserver.observe(this.card);
    this.resize();
  }

  resize() {
    const width = Math.max(1, this.stage.clientWidth);
    const height = Math.max(1, this.stage.clientHeight);

    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  setupControlEvents() {
    this.controlsElement.addEventListener("click", (event) => {
      const button = event.target.closest(".viewer-mode");
      if (!button || button.disabled) {
        return;
      }

      if (button.dataset.mode === "skeleton") {
        this.setMode("skeleton", button.dataset.group);
      } else {
        this.setMode(button.dataset.mode);
      }
    });
  }

  prepareModel() {
    const seenBones = new Set();

    this.model.traverse((object) => {
      if (!object.isMesh) {
        return;
      }

      object.castShadow = true;
      object.receiveShadow = true;

      const displayMaterial = createClayMaterial();
      object.material = displayMaterial;

      if (!object.isSkinnedMesh) {
        return;
      }

      const weightGeometry = this.createWeightGeometry(object);
      const weightMaterial = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        metalness: 0,
        roughness: CLAY_ROUGHNESS,
        side: THREE.DoubleSide,
        transparent: false,
        opacity: 1,
        depthWrite: true,
        vertexColors: true,
      });

      this.meshRecords.push({
        mesh: object,
        originalGeometry: object.geometry,
        displayMaterial,
        weightGeometry,
        weightMaterial,
      });

      object.skeleton.bones.forEach((bone) => {
        if (seenBones.has(bone.uuid)) {
          return;
        }

        seenBones.add(bone.uuid);
        const group = classifyBone(bone.name);
        this.boneRecords.push({ bone, group });
      });
    });
  }

  createWeightGeometry(skinnedMesh) {
    const geometry = skinnedMesh.geometry.clone();
    const position = geometry.getAttribute("position");
    const skinIndex = geometry.getAttribute("skinIndex");
    const skinWeight = geometry.getAttribute("skinWeight");
    const colors = new Float32Array(position.count * 3);
    const bones = skinnedMesh.skeleton.bones;
    const channelGetters = ["getX", "getY", "getZ", "getW"];

    if (!skinIndex || !skinWeight) {
      colors.fill(0.72);
      geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      return geometry;
    }

    for (let vertexIndex = 0; vertexIndex < position.count; vertexIndex += 1) {
      let red = 0;
      let green = 0;
      let blue = 0;
      let totalWeight = 0;

      for (const getter of channelGetters) {
        const weight = skinWeight[getter](vertexIndex);
        if (weight <= 0) {
          continue;
        }

        const boneIndex = Math.round(skinIndex[getter](vertexIndex));
        const bone = bones[boneIndex];
        const boneColor = colorForBone(bone?.name, boneIndex);

        red += boneColor.r * weight;
        green += boneColor.g * weight;
        blue += boneColor.b * weight;
        totalWeight += weight;
      }

      if (totalWeight > 0) {
        red /= totalWeight;
        green /= totalWeight;
        blue /= totalWeight;
      } else {
        red = 0.65;
        green = 0.65;
        blue = 0.65;
      }

      const colorOffset = vertexIndex * 3;
      colors[colorOffset] = red;
      colors[colorOffset + 1] = green;
      colors[colorOffset + 2] = blue;
    }

    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    return geometry;
  }

  fitModelToStage() {
    this.model.updateMatrixWorld(true);

    const initialBox = new THREE.Box3().setFromObject(this.model);
    const center = initialBox.getCenter(new THREE.Vector3());
    const size = initialBox.getSize(new THREE.Vector3());
    const largestDimension = Math.max(size.x, size.y, size.z) || 1;

    this.model.position.sub(center);
    this.model.scale.setScalar(2.15 / largestDimension);
    this.model.updateMatrixWorld(true);

    const fittedBox = new THREE.Box3().setFromObject(this.model);
    const fittedCenter = fittedBox.getCenter(new THREE.Vector3());
    this.orbitControls.target.copy(fittedCenter);

    const groundMaterial = new THREE.ShadowMaterial({
      color: 0x7d8794,
      opacity: 0.16,
      transparent: true,
    });
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), groundMaterial);
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = fittedBox.min.y - 0.018;
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);

    const radius = Math.max(fittedBox.getSize(new THREE.Vector3()).length() * 0.72, 1.35);
    this.camera.position.set(
      fittedCenter.x + radius * 1.15,
      fittedCenter.y + radius * 0.38,
      fittedCenter.z + radius * 1.65,
    );
    this.camera.near = Math.max(radius / 100, 0.01);
    this.camera.far = radius * 30;
    this.camera.updateProjectionMatrix();
    this.orbitControls.minDistance = radius * 0.9;
    this.orbitControls.maxDistance = radius * 4.5;
    this.orbitControls.update();
  }

  buildBoneButtons() {
    const availableGroups = new Set(this.boneRecords.map((record) => record.group));
    const orderedGroups = [
      ...(availableGroups.has("body") ? ["body"] : []),
      ...BONE_KEYWORDS.filter((keyword) => availableGroups.has(keyword)),
    ];

    orderedGroups.forEach((group) => {
      const button = document.createElement("button");
      button.className = "viewer-mode";
      button.type = "button";
      button.dataset.mode = "skeleton";
      button.dataset.group = group;
      button.textContent = group === "body" ? "Body" : titleCase(group);
      button.setAttribute("aria-pressed", "false");
      this.boneButtonHost.append(button);
    });
  }

  enableControls() {
    this.controlsElement.querySelectorAll(".viewer-mode").forEach((button) => {
      button.disabled = false;
    });
    this.updateActiveButtons();
  }

  setMode(nextMode, group = null) {
    if (
      (nextMode === "weights" && this.mode === "weights") ||
      (nextMode === "skeleton" && this.mode === "skeleton" && this.activeGroup === group)
    ) {
      nextMode = "mesh";
      group = null;
    }

    this.restoreMeshMaterials();
    this.clearSkeletonVisual();
    this.model.visible = true;

    if (nextMode === "weights") {
      this.applyWeightMaterials();
    } else if (nextMode === "skeleton") {
      this.model.updateMatrixWorld(true);
      this.createSkeletonVisual(group);
    }

    this.mode = nextMode;
    this.activeGroup = nextMode === "skeleton" ? group : null;
    this.updateActiveButtons();
  }

  applyWeightMaterials() {
    this.meshRecords.forEach((record) => {
      record.mesh.geometry = record.weightGeometry;
      record.mesh.material = record.weightMaterial;
    });
  }

  restoreMeshMaterials() {
    this.meshRecords.forEach((record) => {
      record.mesh.geometry = record.originalGeometry;
      record.mesh.material = record.displayMaterial;
    });
  }

  createSkeletonVisual(group) {
    const records = this.boneRecords.filter((record) => record.group === group);
    const visual = new THREE.Group();
    visual.name = `skeleton-${group}`;

    if (records.length === 0) {
      this.skeletonVisual = visual;
      this.scene.add(visual);
      return;
    }

    const groupColor = colorForGroup(group);
    const material = new THREE.MeshStandardMaterial({
      color: groupColor,
      emissive: groupColor.clone().multiplyScalar(0.16),
      metalness: 0,
      roughness: 0.42,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    const jointGeometry = new THREE.SphereGeometry(JOINT_RADIUS, 16, 12);
    const boneGeometry = new THREE.CylinderGeometry(
      BONE_RADIUS,
      BONE_RADIUS,
      1,
      12,
      1,
      false,
    );

    const visibleJointIds = new Set();
    const addJoint = (bone) => {
      if (visibleJointIds.has(bone.uuid)) {
        return;
      }

      visibleJointIds.add(bone.uuid);
      const joint = new THREE.Mesh(jointGeometry, material);
      joint.position.copy(bone.getWorldPosition(new THREE.Vector3()));
      joint.renderOrder = 11;
      visual.add(joint);
    };

    records.forEach(({ bone }) => {
      addJoint(bone);

      if (!bone.parent?.isBone) {
        return;
      }

      addJoint(bone.parent);
      const jointPosition = bone.getWorldPosition(new THREE.Vector3());
      const parentPosition = bone.parent.getWorldPosition(new THREE.Vector3());
      const direction = jointPosition.clone().sub(parentPosition);
      const length = direction.length();

      if (length <= Number.EPSILON) {
        return;
      }

      const boneSegment = new THREE.Mesh(boneGeometry, material);
      boneSegment.position.copy(parentPosition).add(jointPosition).multiplyScalar(0.5);
      boneSegment.quaternion.setFromUnitVectors(
        CYLINDER_UP_AXIS,
        direction.normalize(),
      );
      boneSegment.scale.set(1, length, 1);
      boneSegment.renderOrder = 10;
      visual.add(boneSegment);
    });

    this.skeletonVisual = visual;
    this.scene.add(visual);
  }

  clearSkeletonVisual() {
    if (!this.skeletonVisual) {
      return;
    }

    this.skeletonVisual.traverse((object) => {
      object.geometry?.dispose();
      object.material?.dispose();
    });
    this.scene.remove(this.skeletonVisual);
    this.skeletonVisual = null;
  }

  updateActiveButtons() {
    this.controlsElement.querySelectorAll(".viewer-mode").forEach((button) => {
      const isSkeletonButton = button.dataset.mode === "skeleton";
      const isActive = isSkeletonButton
        ? this.mode === "skeleton" && button.dataset.group === this.activeGroup
        : button.dataset.mode === this.mode;

      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-pressed", String(isActive));
    });
  }
}

document.querySelectorAll(".rig-viewer").forEach((card) => {
  const viewer = new RigViewer(card);
  viewer.init();
});
