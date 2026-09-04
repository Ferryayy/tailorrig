export const BONE_KEYWORDS = Object.freeze([
  "skirt",
  "hair",
  "sleeve",
  "cape",
  "accessory",
]);

const annotationCache = new Map();

export function classifyBone(name) {
  const normalizedName = String(name || "").toLowerCase();
  return BONE_KEYWORDS.find((keyword) => normalizedName.includes(keyword)) || "body";
}

function annotationUrlForModel(modelUrl) {
  const url = new URL(modelUrl, window.location.href);
  if (!/\.glb$/i.test(url.pathname)) return null;
  url.pathname = url.pathname.replace(/\.glb$/i, ".json");
  url.search = "";
  url.hash = "";
  return url.href;
}

async function fetchBoneLabels(annotationUrl) {
  try {
    const response = await fetch(annotationUrl);
    if (response.status === 404) return null;
    if (!response.ok) {
      console.warn(`Unable to load bone annotations from ${annotationUrl}: ${response.status}`);
      return null;
    }

    const payload = await response.json();
    if (!Array.isArray(payload?.bones)) {
      console.warn(`Bone annotation file has no bones array: ${annotationUrl}`);
      return null;
    }

    const labels = new Map();
    payload.bones.forEach((entry) => {
      if (typeof entry?.original_name !== "string" || typeof entry?.display_name !== "string") {
        return;
      }
      if (!labels.has(entry.original_name)) labels.set(entry.original_name, entry.display_name);
    });
    return labels;
  } catch (error) {
    console.warn(`Unable to read bone annotations from ${annotationUrl}`, error);
    return null;
  }
}

export function loadBoneLabelsForModel(modelUrl) {
  const annotationUrl = annotationUrlForModel(modelUrl);
  if (!annotationUrl) return Promise.resolve(null);
  if (!annotationCache.has(annotationUrl)) {
    annotationCache.set(annotationUrl, fetchBoneLabels(annotationUrl));
  }
  return annotationCache.get(annotationUrl);
}

export function semanticBoneName(boneName, labels) {
  return labels?.get(String(boneName || "")) || String(boneName || "");
}
