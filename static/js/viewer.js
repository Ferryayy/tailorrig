import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import {
  BONE_KEYWORDS,
  classifyBone,
  loadBoneLabelsForModel,
  semanticBoneName,
} from "./bone-labels.js?v=20260904-1";

const loader = new GLTFLoader();
const CLAY_COLOR = 0xb8bec8;
const CLAY_ROUGHNESS = 0.82;
const MODEL_TARGET_SIZE = 2.25;
const CAMERA_PADDING = 1.14;
const NORMAL_CREASE_COSINE = Math.cos(THREE.MathUtils.degToRad(52));

const BONE_GROUP_COLORS = Object.freeze({
  body: 0x2f80ed,
  skirt: 0xf59e0b,
  hair: 0x8b5cf6,
  sleeve: 0x10b981,
  cape: 0xef476f,
  accessory: 0x14b8a6,
  collar: 0xec4899,
  correction: 0x84cc16,
  face: 0x06b6d4,
  muscle: 0xf97316,
  twist: 0x4f46e5,
});
const DEFAULT_BONE_GROUP_COLOR = 0x64748b;
const JOINT_RADIUS = 0.027;
const BONE_RADIUS = 0.012;
const CYLINDER_UP_AXIS = new THREE.Vector3(0, 1, 0);
const INITIAL_VIEW_DIRECTION = new THREE.Vector3(0.82, 0.24, 1.4).normalize();
const VIEWER_RELEASE_DELAY = 500;
const MAX_CONCURRENT_VIEWER_LOADS = 2;
const viewerLoadQueue = [];
let activeViewerLoads = 0;

function processViewerLoadQueue() {
  while (activeViewerLoads < MAX_CONCURRENT_VIEWER_LOADS && viewerLoadQueue.length > 0) {
    const viewer = viewerLoadQueue.shift();
    viewer.isQueued = false;

    if (!viewer.isVisible || viewer.isInitialized || viewer.isLoading) {
      continue;
    }

    activeViewerLoads += 1;
    viewer.startLoading().finally(() => {
      activeViewerLoads -= 1;
      processViewerLoadQueue();
    });
  }
}

function queueViewerLoad(viewer) {
  viewerLoadQueue.push(viewer);
  processViewerLoadQueue();
}

function collectMaterialResources(material, materials, textures) {
  materialList(material).forEach((entry) => {
    if (!entry || materials.has(entry)) {
      return;
    }

    materials.add(entry);
    Object.values(entry).forEach((value) => {
      if (value?.isTexture) {
        textures.add(value);
      }
    });
  });
}

function disposeObjectResources(root) {
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();

  root?.traverse((object) => {
    if (object.geometry) {
      geometries.add(object.geometry);
    }
    if (object.material) {
      collectMaterialResources(object.material, materials, textures);
    }
  });

  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
  textures.forEach((texture) => texture.dispose());
}

function titleCase(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
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
    side: THREE.FrontSide,
    transparent: false,
    opacity: 1,
    depthWrite: true,
    vertexColors: false,
  });
}

function materialList(material) {
  return Array.isArray(material) ? material : [material];
}

function materialHasTexture(material) {
  return materialList(material).some((entry) => (
    entry && Object.values(entry).some((value) => value?.isTexture)
  ));
}

function cloneMaterial(material) {
  if (Array.isArray(material)) {
    return material.map((entry) => entry.clone());
  }

  return material.clone();
}

// Several exported examples contain a separate vertex normal for almost every
// triangle. Average normals only across coincident vertices whose source normals
// already point in a similar direction, preserving intentional creases while
// removing the faceted/rippled shading caused by split export normals.
function createSmoothedGeometry(sourceGeometry) {
  const geometry = sourceGeometry.clone();
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");

  if (!position) {
    return geometry;
  }

  if (!normal) {
    geometry.computeVertexNormals();
    return geometry;
  }

  geometry.computeBoundingBox();
  const diagonal = geometry.boundingBox
    .getSize(new THREE.Vector3())
    .length();
  const quantization = Math.max(diagonal * 1e-6, 1e-7);
  const positionGroups = new Map();

  for (let vertexIndex = 0; vertexIndex < position.count; vertexIndex += 1) {
    const key = [
      Math.round(position.getX(vertexIndex) / quantization),
      Math.round(position.getY(vertexIndex) / quantization),
      Math.round(position.getZ(vertexIndex) / quantization),
    ].join(":");
    const group = positionGroups.get(key);

    if (group) {
      group.push(vertexIndex);
    } else {
      positionGroups.set(key, [vertexIndex]);
    }
  }

  const smoothedNormals = new Float32Array(normal.count * 3);
  const referenceNormal = new THREE.Vector3();
  const candidateNormal = new THREE.Vector3();
  const averagedNormal = new THREE.Vector3();

  positionGroups.forEach((vertexIndices) => {
    vertexIndices.forEach((vertexIndex) => {
      referenceNormal.fromBufferAttribute(normal, vertexIndex).normalize();
      averagedNormal.set(0, 0, 0);

      vertexIndices.forEach((candidateIndex) => {
        candidateNormal.fromBufferAttribute(normal, candidateIndex).normalize();
        if (referenceNormal.dot(candidateNormal) >= NORMAL_CREASE_COSINE) {
          averagedNormal.add(candidateNormal);
        }
      });

      if (averagedNormal.lengthSq() <= Number.EPSILON) {
        averagedNormal.copy(referenceNormal);
      } else {
        averagedNormal.normalize();
      }

      averagedNormal.toArray(smoothedNormals, vertexIndex * 3);
    });
  });

  geometry.setAttribute("normal", new THREE.BufferAttribute(smoothedNormals, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

function boxCorners(box) {
  const { min, max } = box;
  return [
    new THREE.Vector3(min.x, min.y, min.z),
    new THREE.Vector3(min.x, min.y, max.z),
    new THREE.Vector3(min.x, max.y, min.z),
    new THREE.Vector3(min.x, max.y, max.z),
    new THREE.Vector3(max.x, min.y, min.z),
    new THREE.Vector3(max.x, min.y, max.z),
    new THREE.Vector3(max.x, max.y, min.z),
    new THREE.Vector3(max.x, max.y, max.z),
  ];
}

function fitDistanceForBox(box, camera, direction) {
  const center = box.getCenter(new THREE.Vector3());
  const right = new THREE.Vector3()
    .crossVectors(camera.up, direction)
    .normalize();
  const screenUp = new THREE.Vector3()
    .crossVectors(direction, right)
    .normalize();
  const verticalHalfFov = THREE.MathUtils.degToRad(camera.fov * 0.5);
  const horizontalHalfFov = Math.atan(
    Math.tan(verticalHalfFov) * Math.max(camera.aspect, 0.01),
  );
  const verticalTangent = Math.tan(verticalHalfFov);
  const horizontalTangent = Math.tan(horizontalHalfFov);
  let requiredDistance = 0;

  boxCorners(box).forEach((corner) => {
    const offset = corner.sub(center);
    const depthTowardCamera = offset.dot(direction);
    const horizontalExtent = Math.abs(offset.dot(right));
    const verticalExtent = Math.abs(offset.dot(screenUp));

    requiredDistance = Math.max(
      requiredDistance,
      depthTowardCamera + (horizontalExtent * CAMERA_PADDING) / horizontalTangent,
      depthTowardCamera + (verticalExtent * CAMERA_PADDING) / verticalTangent,
    );
  });

  return Math.max(requiredDistance, 0.01);
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
    this.modelRoot = null;
    this.ground = null;
    this.skeletonVisual = null;
    this.skeletonJoints = [];
    this.skeletonSegments = [];
    this.meshRecords = [];
    this.boneRecords = [];
    this.hasTextureMaterial = false;
    this.mixer = null;
    this.animationAction = null;
    this.isVisible = false;
    this.hasUserFramedView = false;
    this.fittedBox = null;
    this.lastFrameTime = null;
    this.isInitialized = false;
    this.isLoading = false;
    this.isQueued = false;
    this.loadGeneration = 0;
    this.releaseTimer = null;

    this.setupControlEvents();
  }

  init() {
    if (this.isInitialized || this.isLoading || this.isQueued) {
      return;
    }

    this.isQueued = true;
    queueViewerLoad(this);
  }

  async startLoading() {
    if (!this.isVisible || this.isInitialized || this.isLoading) {
      return;
    }

    this.isLoading = true;
    const loadGeneration = ++this.loadGeneration;
    this.status.hidden = false;
    this.status.textContent = this.card.dataset.animation
      ? "Loading animation…"
      : "Loading 3D model…";
    this.status.classList.remove("is-error");

    try {
      this.setupScene();
      this.setupObservers();
      const [gltf, boneLabels] = await Promise.all([
        loader.loadAsync(this.modelUrl),
        loadBoneLabelsForModel(this.modelUrl),
      ]);
      if (loadGeneration !== this.loadGeneration) {
        disposeObjectResources(gltf.scene);
        return;
      }

      this.model = gltf.scene;
      this.modelRoot = new THREE.Group();
      this.modelRoot.add(this.model);
      this.scene.add(this.modelRoot);

      this.prepareModel(boneLabels);
      this.prepareAnimation(gltf.animations);
      this.fitModelToStage();
      this.buildTextureButton();
      this.buildBoneButtons();
      this.enableControls();
      this.status.hidden = true;
      this.card.classList.remove("is-loading");
      this.card.setAttribute("aria-busy", "false");
      this.isInitialized = true;
    } catch (error) {
      if (loadGeneration !== this.loadGeneration) {
        return;
      }

      console.error(`Unable to load ${this.modelUrl}`, error);
      this.status.textContent = "Unable to load this model.";
      this.status.classList.add("is-error");
      this.card.classList.remove("is-loading");
      this.card.setAttribute("aria-busy", "false");
      this.isInitialized = true;
    } finally {
      if (loadGeneration === this.loadGeneration) {
        this.isLoading = false;
      }
    }
  }

  setupScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xf3f5f8);

    this.camera = new THREE.PerspectiveCamera(32, 1, 0.01, 100);

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      canvas: this.canvas,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    const hemisphereLight = new THREE.HemisphereLight(0xffffff, 0xb8c0cc, 2.35);
    this.scene.add(hemisphereLight);

    const keyLight = new THREE.DirectionalLight(0xffffff, 2.35);
    keyLight.position.set(3.5, 5, 4.5);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(1536, 1536);
    keyLight.shadow.camera.near = 0.1;
    keyLight.shadow.camera.far = 20;
    keyLight.shadow.bias = -0.00015;
    keyLight.shadow.normalBias = 0.035;
    this.scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0xc9dcff, 1.2);
    fillLight.position.set(-4, 2, -3);
    this.scene.add(fillLight);

    this.orbitControls = new OrbitControls(this.camera, this.canvas);
    this.orbitControls.enableDamping = true;
    this.orbitControls.dampingFactor = 0.055;
    this.orbitControls.enablePan = false;
    this.orbitControls.autoRotate = true;
    this.orbitControls.autoRotateSpeed = 0.65;
    this.orbitControls.target.set(0, 0, 0);
    this.orbitControls.addEventListener("start", () => {
      this.hasUserFramedView = true;
    });

    this.renderer.setAnimationLoop((time) => {
      const delta = this.lastFrameTime === null
        ? 0
        : Math.min((time - this.lastFrameTime) / 1000, 0.1);
      this.lastFrameTime = time;

      if (!this.isVisible) {
        return;
      }

      if (this.mixer) {
        this.mixer.update(delta);
      }

      if (this.skeletonVisual) {
        this.modelRoot.updateMatrixWorld(true);
        this.updateSkeletonVisualPositions();
      }

      this.orbitControls.update();
      this.renderer.render(this.scene, this.camera);
    });
  }

  setupObservers() {
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.stage);
    this.resize();
  }

  setVisible(isVisible) {
    this.isVisible = isVisible;

    if (isVisible) {
      window.clearTimeout(this.releaseTimer);
      this.releaseTimer = null;
      this.init();
      return;
    }

    if (!this.isInitialized && !this.isLoading) {
      return;
    }

    window.clearTimeout(this.releaseTimer);
    this.releaseTimer = window.setTimeout(() => this.destroy(), VIEWER_RELEASE_DELAY);
  }

  destroy() {
    window.clearTimeout(this.releaseTimer);
    this.releaseTimer = null;
    this.loadGeneration += 1;
    this.isLoading = false;
    this.isQueued = false;
    this.isInitialized = false;
    this.isVisible = false;

    this.renderer?.setAnimationLoop(null);
    this.resizeObserver?.disconnect();
    this.orbitControls?.dispose();
    this.clearSkeletonVisual();

    const geometries = new Set();
    const materials = new Set();
    const textures = new Set();
    this.meshRecords.forEach((record) => {
      [record.displayGeometry, record.weightGeometry].forEach((geometry) => {
        if (geometry) {
          geometries.add(geometry);
        }
      });
      [record.displayMaterial, record.textureMaterial, record.weightMaterial].forEach((material) => {
        if (material) {
          collectMaterialResources(material, materials, textures);
        }
      });
    });
    if (this.ground) {
      geometries.add(this.ground.geometry);
      collectMaterialResources(this.ground.material, materials, textures);
    }

    geometries.forEach((geometry) => geometry.dispose());
    materials.forEach((material) => material.dispose());
    textures.forEach((texture) => texture.dispose());

    if (this.renderer) {
      this.renderer.dispose();
      this.renderer.forceContextLoss();
    }

    this.mixer?.stopAllAction();
    if (this.mixer && this.model) {
      this.mixer.uncacheRoot(this.model);
    }

    this.controlsElement.querySelector('[data-mode="texture"]')?.remove();
    this.boneButtonHost.replaceChildren();
    this.controlsElement.querySelectorAll(".viewer-mode").forEach((button) => {
      button.disabled = true;
      const isMesh = button.dataset.mode === "mesh";
      button.classList.toggle("is-active", isMesh);
      button.setAttribute("aria-pressed", String(isMesh));
    });

    const replacementCanvas = this.canvas.cloneNode(false);
    this.canvas.replaceWith(replacementCanvas);
    this.canvas = replacementCanvas;
    this.status.hidden = false;
    this.status.textContent = this.card.dataset.animation
      ? "Loading animation…"
      : "Loading 3D model…";
    this.status.classList.remove("is-error");
    this.card.classList.add("is-loading");
    this.card.setAttribute("aria-busy", "true");

    this.mode = "mesh";
    this.activeGroup = null;
    this.model = null;
    this.modelRoot = null;
    this.ground = null;
    this.skeletonVisual = null;
    this.meshRecords = [];
    this.boneRecords = [];
    this.hasTextureMaterial = false;
    this.mixer = null;
    this.animationClip = null;
    this.animationAction = null;
    this.fittedBox = null;
    this.lastFrameTime = null;
    this.renderer = null;
    this.scene = null;
    this.camera = null;
    this.orbitControls = null;
    this.resizeObserver = null;
  }

  resize() {
    const width = Math.max(1, this.stage.clientWidth);
    const height = Math.max(1, this.stage.clientHeight);

    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();

    if (this.fittedBox && !this.hasUserFramedView) {
      this.frameCameraToBox(this.fittedBox);
    }
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

  prepareModel(boneLabels) {
    const seenBones = new Set();

    this.model.traverse((object) => {
      if (!object.isMesh) {
        return;
      }

      object.castShadow = true;
      object.receiveShadow = true;

      const sourceMaterial = object.material;
      const sourceGeometry = object.geometry;
      const textureMaterial = cloneMaterial(sourceMaterial);
      const hasTexture = materialHasTexture(sourceMaterial);
      const displayGeometry = createSmoothedGeometry(sourceGeometry);
      const displayMaterial = createClayMaterial();
      const weightGeometry = object.isSkinnedMesh
        ? this.createWeightGeometry(object, displayGeometry)
        : null;
      const weightMaterial = weightGeometry
        ? new THREE.MeshStandardMaterial({
          color: 0xffffff,
          metalness: 0,
          roughness: CLAY_ROUGHNESS,
          side: THREE.FrontSide,
          transparent: false,
          opacity: 1,
          depthWrite: true,
          vertexColors: true,
        })
        : null;

      object.geometry = displayGeometry;
      object.material = displayMaterial;
      sourceGeometry.dispose();
      this.hasTextureMaterial ||= hasTexture;
      this.meshRecords.push({
        mesh: object,
        displayGeometry,
        displayMaterial,
        textureMaterial,
        hasTexture,
        weightGeometry,
        weightMaterial,
      });

      if (!object.isSkinnedMesh) {
        return;
      }

      object.skeleton.bones.forEach((bone) => {
        if (seenBones.has(bone.uuid)) {
          return;
        }

        seenBones.add(bone.uuid);
        const semanticName = semanticBoneName(bone.name, boneLabels);
        this.boneRecords.push({
          bone,
          group: classifyBone(semanticName),
          semanticName,
        });
      });
    });
  }

  prepareAnimation(animations) {
    const clip = animations?.[0];
    if (!clip) {
      return;
    }

    this.mixer = new THREE.AnimationMixer(this.model);
    this.animationClip = clip;
    this.animationAction = this.mixer.clipAction(clip);
    this.animationAction.setLoop(THREE.LoopRepeat, Infinity);
    this.animationAction.play();
    this.mixer.update(0);
  }

  createWeightGeometry(skinnedMesh, displayGeometry) {
    const geometry = displayGeometry.clone();
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
    this.modelRoot.updateMatrixWorld(true);

    const initialBox = this.computeContentBounds();
    const center = initialBox.getCenter(new THREE.Vector3());
    const size = initialBox.getSize(new THREE.Vector3());
    const largestDimension = Math.max(size.x, size.y, size.z) || 1;
    const scale = MODEL_TARGET_SIZE / largestDimension;

    this.modelRoot.scale.setScalar(scale);
    this.modelRoot.position.copy(center).multiplyScalar(-scale);
    this.modelRoot.updateMatrixWorld(true);

    this.fittedBox = initialBox.clone();
    this.fittedBox.min.multiplyScalar(scale).add(this.modelRoot.position);
    this.fittedBox.max.multiplyScalar(scale).add(this.modelRoot.position);
    this.frameCameraToBox(this.fittedBox);
    this.createGround(this.fittedBox);
  }

  computeContentBounds() {
    if (!this.mixer || !this.animationClip) {
      return new THREE.Box3().setFromObject(this.modelRoot, true);
    }

    const bounds = new THREE.Box3().makeEmpty();
    const sampleCount = Math.max(
      24,
      Math.min(72, Math.ceil(this.animationClip.duration * 12)),
    );

    for (let sampleIndex = 0; sampleIndex <= sampleCount; sampleIndex += 1) {
      const sampleTime = (this.animationClip.duration * sampleIndex) / sampleCount;
      this.mixer.setTime(sampleTime);
      this.modelRoot.updateMatrixWorld(true);
      bounds.union(new THREE.Box3().setFromObject(this.modelRoot, true));
    }

    this.mixer.setTime(0);
    this.modelRoot.updateMatrixWorld(true);
    return bounds;
  }

  frameCameraToBox(box) {
    const center = box.getCenter(new THREE.Vector3());
    const distance = fitDistanceForBox(box, this.camera, INITIAL_VIEW_DIRECTION);
    const radius = Math.max(
      box.getBoundingSphere(new THREE.Sphere()).radius,
      0.01,
    );

    this.camera.position
      .copy(center)
      .addScaledVector(INITIAL_VIEW_DIRECTION, distance);
    this.camera.near = Math.max(distance / 100, 0.001);
    this.camera.far = distance + radius * 6;
    this.camera.lookAt(center);
    this.camera.updateProjectionMatrix();

    this.orbitControls.target.copy(center);
    this.orbitControls.minDistance = Math.max(distance * 0.42, radius * 0.8);
    this.orbitControls.maxDistance = distance * 4.5;
    this.orbitControls.update();
  }

  createGround(box) {
    const boxSize = box.getSize(new THREE.Vector3());
    const groundSize = Math.max(boxSize.x, boxSize.z, 1) * 7;
    const groundMaterial = new THREE.ShadowMaterial({
      color: 0x7d8794,
      opacity: 0.13,
      transparent: true,
    });

    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(groundSize, groundSize),
      groundMaterial,
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = box.min.y - Math.max(boxSize.y * 0.008, 0.012);
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);
  }

  buildTextureButton() {
    if (!this.hasTextureMaterial) {
      return;
    }

    const meshButton = this.controlsElement.querySelector('[data-mode="mesh"]');
    const button = document.createElement("button");
    button.className = "viewer-mode";
    button.type = "button";
    button.dataset.mode = "texture";
    button.textContent = "Tex";
    button.setAttribute("aria-pressed", "false");
    button.disabled = true;
    meshButton?.after(button);
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
      (nextMode === "texture" && this.mode === "texture") ||
      (nextMode === "weights" && this.mode === "weights") ||
      (nextMode === "skeleton" && this.mode === "skeleton" && this.activeGroup === group)
    ) {
      nextMode = "mesh";
      group = null;
    }

    this.restoreMeshMaterials();
    this.clearSkeletonVisual();
    this.modelRoot.visible = true;

    if (nextMode === "weights") {
      this.applyWeightMaterials();
    } else if (nextMode === "texture") {
      this.applyTextureMaterials();
    } else if (nextMode === "skeleton") {
      this.modelRoot.updateMatrixWorld(true);
      this.createSkeletonVisual(group);
    }

    this.mode = nextMode;
    this.activeGroup = nextMode === "skeleton" ? group : null;
    this.updateActiveButtons();
  }

  applyWeightMaterials() {
    this.meshRecords.forEach((record) => {
      if (!record.weightGeometry || !record.weightMaterial) {
        return;
      }

      record.mesh.geometry = record.weightGeometry;
      record.mesh.material = record.weightMaterial;
    });
  }

  applyTextureMaterials() {
    this.meshRecords.forEach((record) => {
      record.mesh.geometry = record.displayGeometry;
      record.mesh.material = record.textureMaterial;
    });
  }

  restoreMeshMaterials() {
    this.meshRecords.forEach((record) => {
      record.mesh.geometry = record.displayGeometry;
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

    this.skeletonResources = { material, jointGeometry, boneGeometry };
    const visibleJointIds = new Set();
    const addJoint = (bone) => {
      if (visibleJointIds.has(bone.uuid)) {
        return;
      }

      visibleJointIds.add(bone.uuid);
      const joint = new THREE.Mesh(jointGeometry, material);
      joint.renderOrder = 11;
      visual.add(joint);
      this.skeletonJoints.push({ bone, mesh: joint });
    };

    records.forEach(({ bone }) => {
      addJoint(bone);

      if (!bone.parent?.isBone) {
        return;
      }

      addJoint(bone.parent);
      const boneSegment = new THREE.Mesh(boneGeometry, material);
      boneSegment.renderOrder = 10;
      visual.add(boneSegment);
      this.skeletonSegments.push({
        bone,
        parentBone: bone.parent,
        mesh: boneSegment,
      });
    });

    this.skeletonVisual = visual;
    this.scene.add(visual);
    this.updateSkeletonVisualPositions();
  }

  updateSkeletonVisualPositions() {
    this.skeletonJoints.forEach(({ bone, mesh }) => {
      mesh.position.copy(bone.getWorldPosition(new THREE.Vector3()));
    });

    this.skeletonSegments.forEach(({ bone, parentBone, mesh }) => {
      const jointPosition = bone.getWorldPosition(new THREE.Vector3());
      const parentPosition = parentBone.getWorldPosition(new THREE.Vector3());
      const direction = jointPosition.clone().sub(parentPosition);
      const length = direction.length();

      mesh.visible = length > Number.EPSILON;
      if (!mesh.visible) {
        return;
      }

      mesh.position.copy(parentPosition).add(jointPosition).multiplyScalar(0.5);
      mesh.quaternion.setFromUnitVectors(
        CYLINDER_UP_AXIS,
        direction.normalize(),
      );
      mesh.scale.set(1, length, 1);
    });
  }

  clearSkeletonVisual() {
    if (!this.skeletonVisual) {
      return;
    }

    this.scene.remove(this.skeletonVisual);
    this.skeletonResources?.jointGeometry.dispose();
    this.skeletonResources?.boneGeometry.dispose();
    this.skeletonResources?.material.dispose();
    this.skeletonVisual = null;
    this.skeletonResources = null;
    this.skeletonJoints = [];
    this.skeletonSegments = [];
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

const viewerObserver = "IntersectionObserver" in window
  ? new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        entry.target.rigViewer?.setVisible(entry.isIntersecting);
      });
    },
    { rootMargin: "140px 160px" },
  )
  : null;

document.querySelectorAll(".rig-viewer").forEach((card) => {
  const viewer = new RigViewer(card);
  card.rigViewer = viewer;

  if (viewerObserver) {
    viewerObserver.observe(card);
  } else {
    viewer.setVisible(true);
  }
});
