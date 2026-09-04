import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import {
  BONE_KEYWORDS,
  classifyBone,
  loadBoneLabelsForModel,
  semanticBoneName,
} from "./bone-labels.js?v=20260904-1";

const TEMPLATE_ROOT = "./source/workflow/templates";
const RIG_URL = "./source/workflow/stage2_3/514_WD.glb";
const TEMPLATES = [
  ...Array.from({ length: 10 }, (_, index) => ({
    label: `Template ${String(index + 1).padStart(2, "0")}`,
    meta: `template${index}`,
    url: `${TEMPLATE_ROOT}/514_mesh_template${index}_predict.fbx`,
  })),
  {
    label: "Template 11",
    meta: "template11",
    url: RIG_URL,
    bodyOnly: true,
  },
];
const ANIMATIONS = [
  { label: "514 WD", meta: "Take 001", url: "./source/workflow/stage4/514_WD.glb" },
];
const STEPS = ["Template", "Auxiliary Bones", "Skinning", "Animation"];

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
const BONE_REVEAL_STEP_MS = 140;
const BONE_REVEAL_DURATION_MS = 320;
const CYLINDER_UP_AXIS = new THREE.Vector3(0, 1, 0);
const INITIAL_VIEW_DIRECTION = new THREE.Vector3(0.82, 0.24, 1.4).normalize();

const gltfLoader = new GLTFLoader();
const fbxLoader = new FBXLoader();
const canvas = document.querySelector("#workflow-canvas");
const stageElement = document.querySelector(".workflow-stage");
const statusElement = document.querySelector("#workflow-status");
const choicesElement = document.querySelector("#choice-list");
const stepNumberElement = document.querySelector("#step-number");
const stepNameElement = document.querySelector("#step-name");
const stepTrackElement = document.querySelector("#step-track");
const nextButton = document.querySelector("#next-button");
const backButton = document.querySelector("#back-button");

function materialList(material) {
  return Array.isArray(material) ? material : [material];
}

function collectMaterialResources(material, materials, textures) {
  materialList(material).forEach((entry) => {
    if (!entry || materials.has(entry)) return;
    materials.add(entry);
    Object.values(entry).forEach((value) => {
      if (value?.isTexture) textures.add(value);
    });
  });
}

function disposeObjectResources(root) {
  const geometries = new Set();
  const materials = new Set();
  const textures = new Set();
  root?.traverse((object) => {
    if (object.geometry) geometries.add(object.geometry);
    if (object.material) collectMaterialResources(object.material, materials, textures);
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
  textures.forEach((texture) => texture.dispose());
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

function createSmoothedGeometry(sourceGeometry) {
  const geometry = sourceGeometry.clone();
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  if (!position) return geometry;
  if (!normal) {
    geometry.computeVertexNormals();
    return geometry;
  }

  geometry.computeBoundingBox();
  const diagonal = geometry.boundingBox.getSize(new THREE.Vector3()).length();
  const quantization = Math.max(diagonal * 1e-6, 1e-7);
  const positionGroups = new Map();
  for (let vertexIndex = 0; vertexIndex < position.count; vertexIndex += 1) {
    const key = [
      Math.round(position.getX(vertexIndex) / quantization),
      Math.round(position.getY(vertexIndex) / quantization),
      Math.round(position.getZ(vertexIndex) / quantization),
    ].join(":");
    const group = positionGroups.get(key);
    if (group) group.push(vertexIndex);
    else positionGroups.set(key, [vertexIndex]);
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
      if (averagedNormal.lengthSq() <= Number.EPSILON) averagedNormal.copy(referenceNormal);
      else averagedNormal.normalize();
      averagedNormal.toArray(smoothedNormals, vertexIndex * 3);
    });
  });
  geometry.setAttribute("normal", new THREE.BufferAttribute(smoothedNormals, 3));
  geometry.computeBoundingSphere();
  return geometry;
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

function titleCase(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function orderedBoneSequence(semanticName, group) {
  const match = String(semanticName || "").match(
    new RegExp(`(?:^|_)${group}_(\\d+)_(\\d+)(?:_|$)`, "i"),
  );
  if (!match) return null;
  return [Number(match[1]), Number(match[2])];
}

function easeOutCubic(value) {
  return 1 - ((1 - value) ** 3);
}

async function loadModelAsset(url) {
  if (/\.fbx$/i.test(url)) {
    const scene = await fbxLoader.loadAsync(url);
    return { scene, animations: scene.animations || [] };
  }
  return gltfLoader.loadAsync(url);
}

function boxCorners(box) {
  const { min, max } = box;
  return [
    new THREE.Vector3(min.x, min.y, min.z), new THREE.Vector3(min.x, min.y, max.z),
    new THREE.Vector3(min.x, max.y, min.z), new THREE.Vector3(min.x, max.y, max.z),
    new THREE.Vector3(max.x, min.y, min.z), new THREE.Vector3(max.x, min.y, max.z),
    new THREE.Vector3(max.x, max.y, min.z), new THREE.Vector3(max.x, max.y, max.z),
  ];
}

function fitDistanceForBox(box, camera, direction) {
  const center = box.getCenter(new THREE.Vector3());
  const right = new THREE.Vector3().crossVectors(camera.up, direction).normalize();
  const screenUp = new THREE.Vector3().crossVectors(direction, right).normalize();
  const verticalHalfFov = THREE.MathUtils.degToRad(camera.fov * 0.5);
  const horizontalHalfFov = Math.atan(Math.tan(verticalHalfFov) * Math.max(camera.aspect, 0.01));
  const verticalTangent = Math.tan(verticalHalfFov);
  const horizontalTangent = Math.tan(horizontalHalfFov);
  let requiredDistance = 0;
  boxCorners(box).forEach((corner) => {
    const offset = corner.sub(center);
    const depthTowardCamera = offset.dot(direction);
    requiredDistance = Math.max(
      requiredDistance,
      depthTowardCamera + (Math.abs(offset.dot(right)) * CAMERA_PADDING) / horizontalTangent,
      depthTowardCamera + (Math.abs(offset.dot(screenUp)) * CAMERA_PADDING) / verticalTangent,
    );
  });
  return Math.max(requiredDistance, 0.01);
}

class WorkflowViewer {
  constructor() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xf3f5f8);
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.01, 100);
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      canvas,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xb8c0cc, 2.35));
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

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.055;
    this.controls.enablePan = false;
    this.controls.autoRotate = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.controls.autoRotateSpeed = 0.65;

    this.modelRoot = null;
    this.ground = null;
    this.meshRecords = [];
    this.boneRecords = [];
    this.skeletonVisual = null;
    this.skeletonJoints = [];
    this.skeletonSegments = [];
    this.skeletonRevealStartedAt = null;
    this.mixer = null;
    this.currentUrl = null;
    this.isPlayingAnimation = false;
    this.loadGeneration = 0;
    this.hasFramedFirstModel = false;
    this.lastFrameTime = null;

    new ResizeObserver(() => this.resize()).observe(stageElement);
    this.resize();
    this.renderer.setAnimationLoop((time) => this.render(time));
  }

  resize() {
    const width = Math.max(1, stageElement.clientWidth);
    const height = Math.max(1, stageElement.clientHeight);
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  render(time) {
    const delta = this.lastFrameTime === null ? 0 : Math.min((time - this.lastFrameTime) / 1000, 0.1);
    this.lastFrameTime = time;
    if (this.mixer) this.mixer.update(delta);
    if (this.skeletonVisual) {
      this.modelRoot?.updateMatrixWorld(true);
      this.updateSkeletonVisualPositions(time);
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  async load(url, { playAnimation = false, force = false } = {}) {
    if (!force && this.currentUrl === url && this.isPlayingAnimation === playAnimation) return;
    const generation = ++this.loadGeneration;
    showStatus(playAnimation ? "Loading animation…" : "Loading 3D model…");
    const [gltf, boneLabels] = await Promise.all([
      loadModelAsset(url),
      loadBoneLabelsForModel(url),
    ]);
    if (generation !== this.loadGeneration) {
      disposeObjectResources(gltf.scene);
      return;
    }

    this.disposeCurrentModel();
    this.modelRoot = new THREE.Group();
    this.modelRoot.add(gltf.scene);
    this.scene.add(this.modelRoot);
    this.prepareModel(boneLabels);
    if (playAnimation) this.prepareAnimation(gltf.animations);
    this.fitModelToStage(!this.hasFramedFirstModel);
    this.hasFramedFirstModel = true;
    this.currentUrl = url;
    this.isPlayingAnimation = playAnimation;
    hideStatus();
  }

  prepareModel(boneLabels) {
    const seenBones = new Set();
    this.modelRoot.traverse((object) => {
      if (object.isBone && !seenBones.has(object.uuid)) {
        seenBones.add(object.uuid);
        const semanticName = semanticBoneName(object.name, boneLabels);
        this.boneRecords.push({
          bone: object,
          group: classifyBone(semanticName),
          semanticName,
        });
      }

      if (!object.isMesh) return;
      object.castShadow = true;
      object.receiveShadow = true;
      const sourceGeometry = object.geometry;
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
          depthWrite: true,
          vertexColors: true,
        })
        : null;

      object.geometry = displayGeometry;
      object.material = displayMaterial;
      sourceGeometry.dispose();
      this.meshRecords.push({ object, displayGeometry, displayMaterial, weightGeometry, weightMaterial });
    });
  }

  prepareAnimation(animations) {
    const clip = animations?.[0];
    if (!clip) return;
    this.mixer = new THREE.AnimationMixer(this.modelRoot);
    const action = this.mixer.clipAction(clip);
    action.setLoop(THREE.LoopRepeat, Infinity);
    action.play();
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
      channelGetters.forEach((getter) => {
        const weight = skinWeight[getter](vertexIndex);
        if (weight <= 0) return;
        const boneIndex = Math.round(skinIndex[getter](vertexIndex));
        const boneColor = colorForBone(bones[boneIndex]?.name, boneIndex);
        red += boneColor.r * weight;
        green += boneColor.g * weight;
        blue += boneColor.b * weight;
        totalWeight += weight;
      });
      if (totalWeight > 0) {
        red /= totalWeight;
        green /= totalWeight;
        blue /= totalWeight;
      } else {
        red = 0.65;
        green = 0.65;
        blue = 0.65;
      }
      colors[vertexIndex * 3] = red;
      colors[vertexIndex * 3 + 1] = green;
      colors[vertexIndex * 3 + 2] = blue;
    }
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    return geometry;
  }

  fitModelToStage(frameCamera) {
    this.modelRoot.updateMatrixWorld(true);
    const initialBox = new THREE.Box3().setFromObject(this.modelRoot, true);
    const center = initialBox.getCenter(new THREE.Vector3());
    const size = initialBox.getSize(new THREE.Vector3());
    const scale = MODEL_TARGET_SIZE / (Math.max(size.x, size.y, size.z) || 1);
    this.modelRoot.scale.setScalar(scale);
    this.modelRoot.position.copy(center).multiplyScalar(-scale);
    this.modelRoot.updateMatrixWorld(true);

    const fittedBox = initialBox.clone();
    fittedBox.min.multiplyScalar(scale).add(this.modelRoot.position);
    fittedBox.max.multiplyScalar(scale).add(this.modelRoot.position);
    if (frameCamera) this.frameCameraToBox(fittedBox);
    this.createGround(fittedBox);
  }

  frameCameraToBox(box) {
    const center = box.getCenter(new THREE.Vector3());
    const distance = fitDistanceForBox(box, this.camera, INITIAL_VIEW_DIRECTION);
    const radius = Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 0.01);
    this.camera.position.copy(center).addScaledVector(INITIAL_VIEW_DIRECTION, distance);
    this.camera.near = Math.max(distance / 100, 0.001);
    this.camera.far = distance + radius * 6;
    this.camera.lookAt(center);
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(center);
    this.controls.minDistance = Math.max(distance * 0.42, radius * 0.8);
    this.controls.maxDistance = distance * 4.5;
    this.controls.update();
  }

  createGround(box) {
    const boxSize = box.getSize(new THREE.Vector3());
    const groundSize = Math.max(boxSize.x, boxSize.z, 1) * 7;
    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(groundSize, groundSize),
      new THREE.ShadowMaterial({ color: 0x7d8794, opacity: 0.13, transparent: true }),
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = box.min.y - Math.max(boxSize.y * 0.008, 0.012);
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);
  }

  showMesh() {
    this.clearSkeletonVisual();
    this.meshRecords.forEach((record) => {
      record.object.geometry = record.displayGeometry;
      record.object.material = record.displayMaterial;
    });
  }

  showWeights() {
    this.clearSkeletonVisual();
    this.meshRecords.forEach((record) => {
      if (!record.weightGeometry || !record.weightMaterial) return;
      record.object.geometry = record.weightGeometry;
      record.object.material = record.weightMaterial;
    });
  }

  showSkeleton(records) {
    this.showSkeletonGroups([{ group: "body", records }]);
  }

  showAuxiliarySkeleton(selectedGroups, animatedGroups = []) {
    const selectedGroupSet = new Set(selectedGroups);
    const animatedGroupSet = new Set(animatedGroups);
    const groups = [
      {
        group: "body",
        records: this.boneRecords.filter(({ group }) => group === "body"),
        animate: false,
      },
      ...BONE_KEYWORDS
        .filter((group) => selectedGroupSet.has(group))
        .map((group) => ({
          group,
          records: this.boneRecords.filter((record) => record.group === group),
          animate: animatedGroupSet.has(group),
        })),
    ];
    this.showSkeletonGroups(groups);
  }

  showSkeletonGroups(groups) {
    this.showMesh();
    const visual = new THREE.Group();
    const materials = new Map();
    const materialForGroup = (group) => {
      if (materials.has(group)) return materials.get(group);
      const color = new THREE.Color(BONE_GROUP_COLORS[group] ?? DEFAULT_BONE_GROUP_COLOR);
      const material = new THREE.MeshStandardMaterial({
        color,
        emissive: color.clone().multiplyScalar(0.16),
        metalness: 0,
        roughness: 0.42,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      });
      materials.set(group, material);
      return material;
    };
    const jointGeometry = new THREE.SphereGeometry(JOINT_RADIUS, 16, 12);
    const boneGeometry = new THREE.CylinderGeometry(BONE_RADIUS, BONE_RADIUS, 1, 12, 1, false);
    this.skeletonResources = { materials, jointGeometry, boneGeometry };
    const visibleJoints = new Map();
    const addJoint = (bone, material, reveal = null) => {
      const existing = visibleJoints.get(bone.uuid);
      if (existing) {
        if (!reveal || (existing.reveal && reveal.delay < existing.reveal.delay)) {
          existing.reveal = reveal;
        }
        return;
      }
      const joint = new THREE.Mesh(jointGeometry, material);
      joint.renderOrder = 11;
      visual.add(joint);
      const entry = { bone, mesh: joint, reveal };
      visibleJoints.set(bone.uuid, entry);
      this.skeletonJoints.push(entry);
    };

    groups.forEach(({ group, records, animate = false }) => {
      const material = materialForGroup(group);
      const orderedRecords = animate
        ? records
          .map((record) => ({ record, order: orderedBoneSequence(record.semanticName, group) }))
          .filter(({ order }) => order)
          .sort((left, right) => (
            left.order[0] - right.order[0]
            || left.order[1] - right.order[1]
            || left.record.semanticName.localeCompare(right.record.semanticName)
          ))
        : [];
      const revealByBoneId = new Map(orderedRecords.map(({ record }, index) => [
        record.bone.uuid,
        { delay: index * BONE_REVEAL_STEP_MS, duration: BONE_REVEAL_DURATION_MS },
      ]));

      records.forEach(({ bone }) => {
        const reveal = revealByBoneId.get(bone.uuid) || null;
        addJoint(bone, material, reveal);
        if (!bone.parent?.isBone) return;
        addJoint(bone.parent, material, reveal ? revealByBoneId.get(bone.parent.uuid) || null : null);
        const segment = new THREE.Mesh(boneGeometry, material);
        segment.renderOrder = 10;
        visual.add(segment);
        this.skeletonSegments.push({ bone, parentBone: bone.parent, mesh: segment, reveal });
      });
    });
    this.skeletonVisual = visual;
    this.skeletonRevealStartedAt = this.skeletonJoints.some(({ reveal }) => reveal)
      || this.skeletonSegments.some(({ reveal }) => reveal)
      ? performance.now()
      : null;
    this.scene.add(visual);
    this.updateSkeletonVisualPositions(performance.now());
  }

  skeletonRevealProgress(reveal, time) {
    if (!reveal || this.skeletonRevealStartedAt === null) return 1;
    const progress = THREE.MathUtils.clamp(
      (time - this.skeletonRevealStartedAt - reveal.delay) / reveal.duration,
      0,
      1,
    );
    return easeOutCubic(progress);
  }

  updateSkeletonVisualPositions(time = performance.now()) {
    this.skeletonJoints.forEach(({ bone, mesh, reveal }) => {
      const progress = this.skeletonRevealProgress(reveal, time);
      mesh.visible = progress > 0;
      mesh.position.copy(bone.getWorldPosition(new THREE.Vector3()));
      mesh.scale.setScalar(progress);
    });
    this.skeletonSegments.forEach(({ bone, parentBone, mesh, reveal }) => {
      const jointPosition = bone.getWorldPosition(new THREE.Vector3());
      const parentPosition = parentBone.getWorldPosition(new THREE.Vector3());
      const direction = jointPosition.clone().sub(parentPosition);
      const length = direction.length();
      const progress = this.skeletonRevealProgress(reveal, time);
      mesh.visible = length > Number.EPSILON && progress > 0;
      if (!mesh.visible) return;
      mesh.position.copy(parentPosition).addScaledVector(direction, progress * 0.5);
      mesh.quaternion.setFromUnitVectors(CYLINDER_UP_AXIS, direction.normalize());
      mesh.scale.set(1, length * progress, 1);
    });
  }

  getNamedAuxiliaryGroups() {
    return BONE_KEYWORDS.map((keyword) => ({
      label: titleCase(keyword),
      meta: keyword,
      records: this.boneRecords.filter(({ group }) => group === keyword),
    }));
  }

  clearSkeletonVisual() {
    if (!this.skeletonVisual) return;
    this.scene.remove(this.skeletonVisual);
    this.skeletonResources?.jointGeometry.dispose();
    this.skeletonResources?.boneGeometry.dispose();
    this.skeletonResources?.materials.forEach((material) => material.dispose());
    this.skeletonVisual = null;
    this.skeletonResources = null;
    this.skeletonJoints = [];
    this.skeletonSegments = [];
    this.skeletonRevealStartedAt = null;
  }

  disposeCurrentModel() {
    this.clearSkeletonVisual();
    this.mixer?.stopAllAction();
    if (this.mixer && this.modelRoot) this.mixer.uncacheRoot(this.modelRoot);
    this.mixer = null;
    if (this.ground) {
      this.scene.remove(this.ground);
      this.ground.geometry.dispose();
      this.ground.material.dispose();
      this.ground = null;
    }
    if (this.modelRoot) {
      this.scene.remove(this.modelRoot);
      disposeObjectResources(this.modelRoot);
    }
    this.meshRecords.forEach((record) => {
      if (record.weightGeometry) record.weightGeometry.dispose();
      if (record.weightMaterial) record.weightMaterial.dispose();
    });
    this.modelRoot = null;
    this.meshRecords = [];
    this.boneRecords = [];
  }
}

const viewer = new WorkflowViewer();
let currentStep = 0;
let selectedTemplate = 0;
const selectedAuxiliaryGroups = new Set();
let hasInitializedAuxiliarySelection = false;
let selectedAnimation = 0;
let skinningVisible = false;
let isBusy = false;

function showStatus(message) {
  statusElement.textContent = message;
  statusElement.classList.remove("is-error");
  statusElement.hidden = false;
}

function hideStatus() {
  statusElement.hidden = true;
  statusElement.classList.remove("is-error");
}

function showError(message) {
  statusElement.textContent = message;
  statusElement.classList.add("is-error");
  statusElement.hidden = false;
}

function choiceMarkup(item) {
  const meta = item.meta ? `<span class="choice-meta">${item.meta}</span>` : "";
  return `<span class="choice-copy"><span>${item.label}</span>${meta}</span><span class="choice-dot" aria-hidden="true"></span>`;
}

function renderChoices(items, activeIndex, label) {
  choicesElement.setAttribute("aria-label", label);
  choicesElement.replaceChildren(...items.map((item, index) => {
    const button = document.createElement("button");
    button.className = `choice-button${index === activeIndex ? " is-active" : ""}`;
    button.type = "button";
    button.dataset.index = String(index);
    button.setAttribute("aria-pressed", String(index === activeIndex));
    button.innerHTML = choiceMarkup(item);
    return button;
  }));
}

function renderMultiChoices(items, activeValues, label) {
  choicesElement.setAttribute("aria-label", label);
  choicesElement.replaceChildren(...items.map((item, index) => {
    const isActive = activeValues.has(item.meta);
    const button = document.createElement("button");
    button.className = `choice-button${isActive ? " is-active" : ""}`;
    button.type = "button";
    button.dataset.index = String(index);
    button.dataset.value = item.meta;
    button.setAttribute("aria-pressed", String(isActive));
    button.innerHTML = choiceMarkup(item);
    return button;
  }));
}

function renderEmptyState(message, label) {
  choicesElement.setAttribute("aria-label", label);
  const emptyState = document.createElement("p");
  emptyState.className = "empty-state";
  emptyState.textContent = message;
  choicesElement.replaceChildren(emptyState);
}

function templateBoneRecords(template) {
  if (!template.bodyOnly) return viewer.boneRecords;
  return viewer.boneRecords.filter(({ group }) => group === "body");
}

function updateChoiceSelection(activeIndex) {
  choicesElement.querySelectorAll(".choice-button").forEach((button, index) => {
    const isActive = index === activeIndex;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  });
}

function setBusy(busy) {
  isBusy = busy;
  choicesElement.querySelectorAll("button").forEach((button) => { button.disabled = busy; });
  nextButton.disabled = busy;
  backButton.disabled = busy;
  choicesElement.setAttribute("aria-busy", String(busy));
}

async function loadSafely(url, options) {
  setBusy(true);
  try {
    await viewer.load(url, options);
    return true;
  } catch (error) {
    console.error(`Unable to load ${url}`, error);
    showError("Unable to load this model.");
    return false;
  } finally {
    setBusy(false);
  }
}

function updateStepChrome() {
  stepNumberElement.textContent = String(currentStep + 1).padStart(2, "0");
  stepNameElement.textContent = STEPS[currentStep];
  stepTrackElement.setAttribute("aria-label", `Step ${currentStep + 1} of ${STEPS.length}`);
  stepTrackElement.querySelectorAll("span").forEach((track, index) => {
    track.classList.toggle("is-active", index <= currentStep);
  });
  backButton.hidden = currentStep === 0;
  nextButton.hidden = currentStep === STEPS.length - 1;
}

async function enterStep(stepIndex) {
  currentStep = stepIndex;
  updateStepChrome();

  if (currentStep === 0) {
    renderChoices(TEMPLATES, selectedTemplate, "Template selection");
    const template = TEMPLATES[selectedTemplate];
    if (await loadSafely(template.url, { playAnimation: false })) {
      viewer.showSkeleton(templateBoneRecords(template));
    }
    return;
  }

  if (currentStep === 1) {
    choicesElement.replaceChildren();
    if (!await loadSafely(RIG_URL, { playAnimation: false })) return;
    const groups = viewer.getNamedAuxiliaryGroups();
    const availableGroups = new Set(
      groups.filter(({ records }) => records.length > 0).map(({ meta }) => meta),
    );
    [...selectedAuxiliaryGroups].forEach((group) => {
      if (!availableGroups.has(group)) selectedAuxiliaryGroups.delete(group);
    });
    const animatedGroups = [];
    if (!hasInitializedAuxiliarySelection) {
      const firstAvailableGroup = groups.find(({ records }) => records.length > 0);
      if (firstAvailableGroup) {
        selectedAuxiliaryGroups.add(firstAvailableGroup.meta);
        animatedGroups.push(firstAvailableGroup.meta);
      }
      hasInitializedAuxiliarySelection = true;
    }
    renderMultiChoices(groups, selectedAuxiliaryGroups, "Auxiliary bone multi-selection");
    viewer.showAuxiliarySkeleton(selectedAuxiliaryGroups, animatedGroups);
    return;
  }

  if (currentStep === 2) {
    if (!await loadSafely(RIG_URL, { playAnimation: false })) return;
    skinningVisible = false;
    viewer.showMesh();
    renderChoices([{ label: "Skinning", meta: "Weight visualization" }], -1, "Skinning visualization");
    return;
  }

  renderChoices(ANIMATIONS, selectedAnimation, "Animation selection");
  await loadSafely(ANIMATIONS[selectedAnimation].url, { playAnimation: true });
}

choicesElement.addEventListener("click", async (event) => {
  const button = event.target.closest(".choice-button");
  if (!button || isBusy) return;
  const index = Number(button.dataset.index);

  if (currentStep === 0) {
    selectedTemplate = index;
    updateChoiceSelection(index);
    const template = TEMPLATES[index];
    if (await loadSafely(template.url, { playAnimation: false })) {
      viewer.showSkeleton(templateBoneRecords(template));
    }
    return;
  }

  if (currentStep === 1) {
    const group = viewer.getNamedAuxiliaryGroups()[index];
    if (!group || group.records.length === 0) return;
    const wasSelected = selectedAuxiliaryGroups.has(group.meta);
    if (wasSelected) selectedAuxiliaryGroups.delete(group.meta);
    else selectedAuxiliaryGroups.add(group.meta);
    const isActive = selectedAuxiliaryGroups.has(group.meta);
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
    viewer.showAuxiliarySkeleton(selectedAuxiliaryGroups, wasSelected ? [] : [group.meta]);
    return;
  }

  if (currentStep === 2) {
    skinningVisible = !skinningVisible;
    updateChoiceSelection(skinningVisible ? 0 : -1);
    if (skinningVisible) viewer.showWeights();
    else viewer.showMesh();
    return;
  }

  selectedAnimation = index;
  updateChoiceSelection(index);
  await loadSafely(ANIMATIONS[index].url, { playAnimation: true });
});

nextButton.addEventListener("click", () => {
  if (!isBusy && currentStep < STEPS.length - 1) enterStep(currentStep + 1);
});

backButton.addEventListener("click", () => {
  if (!isBusy && currentStep > 0) enterStep(currentStep - 1);
});

enterStep(0);
