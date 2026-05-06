// Copyright (c) 2026 Christoph Medicus
// Licensed under the MIT License

import {
  WebGLRenderer, PerspectiveCamera, Scene, Color, Vector3, Quaternion, Euler,
  Box3, MeshStandardMaterial, Mesh, AmbientLight, HemisphereLight, DirectionalLight,
  PMREMGenerator, SRGBColorSpace, Matrix4, Group, MathUtils
} from 'three';

import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { LumaSplatsSemantics, LumaSplatsThree } from '@lumaai/luma-web';

import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';

// ---------- Renderer / Scene base ----------
const renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
renderer.setSize(window.innerWidth, window.innerHeight);

// Default: always white when (re)loading a model
renderer.setClearColor(0xffffff, 1);
renderer.outputColorSpace = SRGBColorSpace;

// document.body.appendChild(renderer.domElement);
const slot = document.getElementById('viewer-slot');
if (slot) slot.appendChild(renderer.domElement);

renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local');

if ('xr' in navigator) {
  navigator.xr.isSessionSupported('immersive-vr').then((supported) => {
    if (supported) {
      const vrButton = VRButton.createButton(renderer);
      vrButton.id = 'VRButton';
      document.body.appendChild(vrButton);
      // Initialize label once
      updateVRButtonLabel();
    }
  }).catch(err => console.error("XR support check failed:", err));
}

window.appRenderer = renderer;

const scene = new Scene();
scene.background = new Color(0xffffff); // start white

const camera = new PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.z = 2;

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

const amb = new AmbientLight(0xffffff, 0.5);
scene.add(amb);
const hemi = new HemisphereLight(0xffffff, 0x222233, 0.7);
scene.add(hemi);
const dir = new DirectionalLight(0xffffff, 0.8);
dir.position.set(5, 5, 5);
scene.add(dir);

const pmrem = new PMREMGenerator(renderer);
pmrem.compileEquirectangularShader();

new RGBELoader().load(
  'https://threejs.org/examples/textures/equirectangular/venice_sunset_1k.hdr',
  (hdrTex) => {
    const envMap = pmrem.fromEquirectangular(hdrTex).texture;
    scene.environment = envMap;
    hdrTex.dispose();
  },
  undefined,
  (err) => { console.warn('HDR env load failed:', err); }
);

// ---------- XR / controls state ----------
let inXR = false;

const controller0 = renderer.xr.getController(0);
const controller1 = renderer.xr.getController(1);
scene.add(controller0, controller1);

const ctrlState = { active: false, lastPos: new Vector3(), controller: null };

let yawTarget = 0, pitchTarget = 0;
let vrYaw = 0, vrPitch = 0;
const ROT_SENS = 1.6;
const MAX_PITCH = Math.PI * 0.49;
const SMOOTH = 0.18;

let distanceTarget = 1.0;
let vrDistance = 1.0;
const MIN_DIST = 0.3;
const MAX_DIST = 3.5;
const DIST_SMOOTH = 0.18;
const STICK_DIST_SENS = 0.025;
let entryYaw = 0;

// ---------- Right-stick step rotation + camera height state ----------
let lastRightStep = 0;          // -1, 0, +1 depending on current tilt region
const STEP_DEADZONE = 0.3;      // ignore small tilts
const STEP_HYST = 0.2;          // hysteresis to prevent rapid flapping
const STEP_ANGLE = Math.PI / 6; // 30 degrees per step

// Camera vertical offset controlled by right stick Y in VR
let camHeightOffset = 0;          // meters (smoothed)
let camHeightTarget = 0;          // meters (raw target)
const CAM_HEIGHT_MIN = -1.0;      // clamp range downwards
const CAM_HEIGHT_MAX =  1.0;      // clamp range upwards
const CAM_HEIGHT_SENS = 0.015;    // sensitivity per frame for right stick Y
const CAM_HEIGHT_SMOOTH = 0.2;    // smoothing factor for vertical offset

// ---------- UI / current model state ----------
let currentObject = null;
let currentIsSplat = false; // true only for Luma splats loaded in Three
let isCurrentSplatType = 'mesh'; // 'mesh' | 'luma' | 'super'
let currentBgMode = 'white';     // 'white' | 'black' | 'original' (for Luma/Super)
const bgBtn = document.getElementById('bg-toggle');

// Supersplat inline iframe
const supersplatFrame = document.getElementById('supersplat-inline');
const SUPER_SPLAT_RX = /superspl\.at\/s\?id=\w+/i;

// ---------- Background label updater (centralized) ----------
function updateBgButtonLabel() {
  const el = document.getElementById('bg-toggle');
  if (!el) return;

  if (isCurrentSplatType === 'luma') {
    el.textContent = (currentBgMode === 'white') ? 'Background' : 'Remove background';
  } else if (isCurrentSplatType === 'super') {
    el.textContent = (currentBgMode === 'white') ? 'Background' : 'Remove background';
  } else {
    el.textContent = (currentBgMode === 'white') ? 'Black Background' : 'White Background';
  }
}

// ---------- XR gamepad helpers ----------
function getControllerAxes(handedness) {
  // Returns the most "active" stick pair for the given handedness.
  const session = renderer.xr.getSession?.();
  if (!session) return null;
  for (const src of session.inputSources) {
    if (!src) continue;
    if (handedness !== 'any' && src.handedness !== handedness) continue;
    const gp = src.gamepad;
    if (!gp || !gp.axes || gp.axes.length < 2) continue;

    const a0 = gp.axes[0] ?? 0, a1 = gp.axes[1] ?? 0;
    const a2 = gp.axes[2] ?? 0, a3 = gp.axes[3] ?? 0;
    const mag01 = Math.hypot(a0, a1);
    const mag23 = Math.hypot(a2, a3);

    if (mag23 > mag01 && gp.axes.length >= 4) {
      return { x: a2, y: a3 };
    } else {
      return { x: a0, y: a1 };
    }
  }
  return null;
}

function getControllerAxesByIndex(index) {
  // Fallback when handedness is 'none' or unreliable: use first two gamepads discovered
  const session = renderer.xr.getSession?.();
  if (!session) return null;
  let i = 0;
  for (const src of session.inputSources) {
    const gp = src.gamepad;
    if (!gp || !gp.axes || gp.axes.length < 2) continue;
    if (i === index) {
      const a0 = gp.axes[0] ?? 0, a1 = gp.axes[1] ?? 0;
      const a2 = gp.axes[2] ?? 0, a3 = gp.axes[3] ?? 0;
      const mag01 = Math.hypot(a0, a1);
      const mag23 = Math.hypot(a2, a3);
      return (mag23 > mag01 && gp.axes.length >= 4) ? { x: a2, y: a3 } : { x: a0, y: a1 };
    }
    i++;
  }
  return null;
}

// Optional: runtime logger (enable temporarily for debugging)
// let _xrDebugTimer = 0;
// function debugXRGamepads(time) {
//   const session = renderer.xr.getSession?.();
//   if (!session) return;
//   if (time < _xrDebugTimer) return;
//   _xrDebugTimer = time + 1000; // log once per second
//   const summary = [];
//   for (const src of session.inputSources) {
//     const gp = src.gamepad;
//     if (!gp) continue;
//     summary.push({
//       hand: src.handedness,
//       axes: Array.from(gp.axes).map(v => +v.toFixed(2)),
//       buttons: gp.buttons?.map(b => (b?.pressed ? 1 : 0)) || []
//     });
//   }
//   if (summary.length) console.debug('[XR gp]', summary);
// }

// ---------- Utilities ----------
function setBackgroundWhite() {
  renderer.setClearColor(0xffffff, 1);
  scene.background = new Color(0xffffff);
  currentBgMode = 'white';
  updateBgButtonLabel();
}

function setBackgroundBlack() {
  renderer.setClearColor(0x000000, 1);
  scene.background = null; // plain black without HDR background
  currentBgMode = 'black';
  updateBgButtonLabel();
}

function setBackgroundOriginalForLuma() {
  if (currentObject instanceof LumaSplatsThree) {
    currentObject.semanticsMask = LumaSplatsSemantics.FOREGROUND | LumaSplatsSemantics.BACKGROUND;
  }
  setBackgroundBlack();
  currentBgMode = 'original';
  updateBgButtonLabel();
}

function setForegroundOnlyForLuma() {
  if (currentObject instanceof LumaSplatsThree) {
    currentObject.semanticsMask = LumaSplatsSemantics.FOREGROUND;
  }
  setBackgroundWhite();
  updateBgButtonLabel();
}

function isLumaCapture(url) {
  return /lumalabs\.ai\/capture\//i.test(url);
}

function removeCurrent() {
  if (!currentObject) return;
  scene.remove(currentObject);

  if (currentIsSplat) {
    currentObject.traverse?.((o) => {
      if (typeof o.dispose === 'function') { try { o.dispose(); } catch (_) {} }
    });
  } else {
    currentObject.traverse?.((child) => {
      if (child.geometry) child.geometry.dispose?.();
      if (child.material) {
        if (Array.isArray(child.material)) child.material.forEach(m => m.dispose?.());
        else child.material.dispose?.();
      }
    });
  }

  currentObject = null;
  currentIsSplat = false;
  isCurrentSplatType = 'mesh';
}

function centerAndNormalize(object3D, targetSize = 1.5) {
  object3D.updateMatrixWorld(true);
  const box = new Box3().setFromObject(object3D);
  if (!isFinite(box.min.x) || !isFinite(box.max.x)) return;

  const size = box.getSize(new Vector3());
  const center = box.getCenter(new Vector3());

  const translation = new Matrix4().makeTranslation(-center.x, -center.y, -center.z);
  object3D.traverse((child) => {
    if (child !== object3D && (child.isMesh || child.isGroup || child.isObject3D)) {
      child.applyMatrix4(translation);
      child.updateMatrixWorld(true);
    }
  });

  const maxDim = Math.max(size.x, size.y, size.z);
  if (maxDim > 0) {
    const scale = targetSize / maxDim;
    object3D.scale.multiplyScalar(scale);
    object3D.updateMatrixWorld(true);
  }
}

function frameByBox(object3D, fitOffset = 1.2) {
  object3D.updateMatrixWorld(true);
  const box = new Box3().setFromObject(object3D);
  const size = box.getSize(new Vector3());
  const center = box.getCenter(new Vector3());

  controls.target.copy(center);

  const maxSize = Math.max(size.x, size.y, size.z);
  const fov = MathUtils.degToRad(camera.fov);
  const fitHeightDistance = (maxSize / 2) / Math.tan(fov / 2);
  const fitWidthDistance = fitHeightDistance / camera.aspect;
  const distance = fitOffset * Math.max(fitHeightDistance, fitWidthDistance);

  const dirVec = new Vector3()
    .subVectors(camera.position, controls.target)
    .normalize()
    .multiplyScalar(distance);

  camera.position.copy(controls.target).add(dirVec);
  camera.near = Math.max(distance / 100, 0.001);
  camera.far = Math.max(distance * 100, 10);
  camera.updateProjectionMatrix();
  controls.update();
}

function prepareMeshMaterial(child) {
  if (!child.isMesh) return;
  if (!child.material) {
    child.material = new MeshStandardMaterial({ color: 0xffffff, metalness: 0.0, roughness: 1.0 });
  }
  const mats = Array.isArray(child.material) ? child.material : [child.material];
  const hasVC = !!(child.geometry && child.geometry.getAttribute && child.geometry.getAttribute('color'));
  mats.forEach(mat => {
    if (hasVC) {
      mat.vertexColors = true;
      if (mat.color) mat.color.set(0xffffff);
    }
    if ('envMapIntensity' in mat) mat.envMapIntensity = Math.min(mat.envMapIntensity ?? 1.0, 1.0);
    if ('metalness' in mat && mat.metalness == null) mat.metalness = 0.0;
    if ('roughness' in mat && mat.roughness == null) mat.roughness = 1.0;
    mat.needsUpdate = true;
  });
  if (child.geometry && !child.geometry.getAttribute('normal') && child.geometry.computeVertexNormals) {
    child.geometry.computeVertexNormals();
  }
}

function placeObjectInFrontOfCamera(obj, distance = 1.0) {
  const xrCam = renderer.xr.getCamera ? renderer.xr.getCamera(camera) : camera;
  const camPos = new Vector3().setFromMatrixPosition(xrCam.matrixWorld);
  const camQuat = new Quaternion().setFromRotationMatrix(xrCam.matrixWorld);
  const forward = new Vector3(0, 0, -1).applyQuaternion(camQuat);
  const targetPos = camPos.clone().add(forward.multiplyScalar(distance));
  obj.position.copy(targetPos);
  const euler = new Euler().setFromQuaternion(camQuat, 'YXZ');
  obj.rotation.set(0, euler.y, 0);
  obj.updateMatrixWorld(true);
  yawTarget = 0; pitchTarget = 0; vrYaw = 0; vrPitch = 0;
  distanceTarget = distance; vrDistance = distance; entryYaw = euler.y;
}

function beginRotateWithController(ctrl) {
  ctrlState.active = true;
  ctrlState.controller = ctrl;
  ctrlState.lastPos.copy(ctrl.position);
}
function endRotateWithController() {
  ctrlState.active = false;
  ctrlState.controller = null;
}
function updateControllerRotation() {
  if (!inXR || !ctrlState.active || !currentObject) return;
  const ctrl = ctrlState.controller;
  const currPos = ctrl.position.clone();
  const delta = currPos.clone().sub(ctrlState.lastPos);
  yawTarget   += delta.x * ROT_SENS;
  pitchTarget -= delta.y * ROT_SENS;
  pitchTarget = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, pitchTarget));
  ctrlState.lastPos.copy(currPos);
}
function getThumbstickY() {
  // Kept for compatibility; not used in VR main loop anymore
  const session = renderer.xr.getSession?.();
  if (!session) return 0;
  let y = 0;
  for (const src of session.inputSources) {
    const gp = src.gamepad;
    if (!gp || !gp.axes || gp.axes.length < 2) continue;
    const candidates = [];
    if (gp.axes.length >= 2) candidates.push(gp.axes[1]);
    if (gp.axes.length >= 4) candidates.push(gp.axes[3]);
    const localY = candidates.reduce((best, v) => Math.abs(v) > Math.abs(best) ? v : best, 0);
    const DZ = 0.15;
    if (Math.abs(localY) > Math.abs(y) && Math.abs(localY) > DZ) y = localY;
  }
  return y;
}

// ---------- VR Button show/hide helpers ----------
function showThreeVRButton() {
  const el = document.getElementById('VRButton');
  if (el) el.style.display = '';
}
function hideThreeVRButton() {
  const el = document.getElementById('VRButton');
  if (el) el.style.display = 'none';
}

// ---------- Supersplat inline ----------
function showSupersplatInline(url) {
  renderer.domElement.classList.add('hidden');
  if (supersplatFrame) {
    supersplatFrame.src = url;
    supersplatFrame.classList.remove('hidden');
  }
  try { if (!inXR) renderer.setAnimationLoop(null); } catch (e) {}
  isCurrentSplatType = 'super';
  currentIsSplat = false;
  setBackgroundWhite();
  setBgButtonLabelForSplat();
  hideThreeVRButton();
  updateBgButtonLabel();
}

function hideSupersplatInline() {
  if (supersplatFrame) {
    supersplatFrame.src = 'about:blank';
    supersplatFrame.classList.add('hidden');
  }
  renderer.domElement.classList.remove('hidden');
  try { if (!inXR && window.appMainLoop) renderer.setAnimationLoop(window.appMainLoop); } catch (e) {}
  showThreeVRButton();
  updateBgButtonLabel();
}

// ---------- Loading ----------
async function loadAny(url) {
  const loadingEl = document.getElementById('loading');
  if (loadingEl) loadingEl.style.display = 'block';

  try {
    if (SUPER_SPLAT_RX.test(url)) {
      if (loadingEl) loadingEl.style.display = 'none';
      removeCurrent();
      showSupersplatInline(url);
      return;
    }

    hideSupersplatInline();
    setBackgroundWhite();

    if (isLumaCapture(url)) {
      removeCurrent();

      const splat = new LumaSplatsThree({ source: url });
      scene.add(splat);
      currentObject = splat;
      currentIsSplat = true;
      isCurrentSplatType = 'luma';

      setForegroundOnlyForLuma();
      setBgButtonLabelForSplat();

      if (inXR && currentObject) {
        placeObjectInFrontOfCamera(currentObject, 1.0);
      } else {
        camera.position.set(0, 0, 2);
        camera.updateProjectionMatrix();
        controls.target.set(0, 0, 0);
        controls.update();
      }

      if (loadingEl) loadingEl.style.display = 'none';
      setTimeout(() => { applyStateForCurrent(url); }, 0);

      showThreeVRButton();
      updateBgButtonLabel();
      return;
    }

    removeCurrent();

    const lower = url.toLowerCase();
    const ext = lower.split('.').pop();
    const normalizedExt = ext === 'glt' ? 'gltf' : ext;

    let loaded = null;

    if (normalizedExt === 'gltf' || normalizedExt === 'glb') {
      const gltf = await new Promise((res, rej) => new GLTFLoader().load(url, res, undefined, rej));
      loaded = gltf.scene || gltf.scenes?.[0];

      if (lower.includes('bienenkasten.glb') || lower.includes('beehive')) {
        loaded.rotation.y = Math.PI / 1.1;
        loaded.rotation.x = Math.PI / 6;
      }

    } else if (normalizedExt === 'fbx') {
      loaded = await new Promise((res, rej) => new FBXLoader().load(url, res, undefined, rej));

    } else if (normalizedExt === 'obj') {
      const objLoader = new OBJLoader();
      const mtlLoader = new MTLLoader();
      const mtlUrl = url.replace('.obj', '.mtl');
      const materials = await new Promise((res, rej) => mtlLoader.load(mtlUrl, res, undefined, rej));
      materials.preload();
      loaded = await new Promise((res, rej) => {
        objLoader.setMaterials(materials);
        objLoader.load(url, res, undefined, rej);
      });

      if (lower.includes('affe_lowpoly_tris.obj') || lower.includes('affe') || lower.includes('monkey')) {
        loaded.rotation.y = Math.PI / 1.1;
        loaded.rotation.x = Math.PI / 8;
      }

    } else if (normalizedExt === 'stl') {
      const geom = await new Promise((res, rej) => new STLLoader().load(url, res, undefined, rej));
      const mat = new MeshStandardMaterial({ color: 0xcccccc, metalness: 0.1, roughness: 0.8 });
      loaded = new Mesh(geom, mat);

    } else if (normalizedExt === 'ply') {
      const geom = await new Promise((res, rej) => new PLYLoader().load(url, res, undefined, rej));
      geom.computeVertexNormals?.();
      const mat = new MeshStandardMaterial({ color: 0xcccccc, metalness: 0.1, roughness: 0.8 });
      loaded = new Mesh(geom, mat);

    } else {
      throw new Error(`Unsupported format: ${ext}`);
    }

    if (!loaded) throw new Error('Model loaded but no scene/object found');

    currentIsSplat = false;
    isCurrentSplatType = 'mesh';

    const wrapper = new Group();
    wrapper.name = 'ModelWrapper';
    wrapper.add(loaded);
    wrapper.traverse((child) => prepareMeshMaterial(child));
    centerAndNormalize(wrapper, 1.5);

    scene.add(wrapper);
    currentObject = wrapper;

    if (inXR && currentObject) placeObjectInFrontOfCamera(currentObject, 1.0);
    frameByBox(wrapper, 1.25);

    setBgButtonLabelForMesh();

    if (loadingEl) loadingEl.style.display = 'none';

    showThreeVRButton();
    updateBgButtonLabel();

  } catch (e) {
    console.error('Loading failed:', e);
    alert(`Failed to load model: ${e.message || e}`);
    if (loadingEl) loadingEl.style.display = 'none';
  }
}

// ---------- BG toggle label helpers (compatibility; central updater is authoritative) ----------
function setBgButtonLabelForSplat() {
  const bgBtnEl = document.getElementById('bg-toggle');
  if (bgBtnEl) bgBtnEl.textContent = 'Background';
}
function setBgButtonLabelForMesh() {
  const bgBtnEl = document.getElementById('bg-toggle');
  if (bgBtnEl) bgBtnEl.textContent = 'Black Background';
}

// ---------- BG toggle click ----------
document.getElementById('bg-toggle')?.addEventListener('click', () => {
  if (isCurrentSplatType === 'luma') {
    if (currentBgMode === 'white') setBackgroundOriginalForLuma();
    else setForegroundOnlyForLuma();
  } else if (isCurrentSplatType === 'super') {
    if (currentBgMode === 'white') {
      setBackgroundBlack();
      currentBgMode = 'original';
    } else {
      setBackgroundWhite();
    }
  } else {
    if (currentBgMode === 'white') setBackgroundBlack();
    else setBackgroundWhite();
  }
  updateBgButtonLabel();
});

// ---------- Luma semantics (height masks), unchanged ----------
const states = [
  { mask: LumaSplatsSemantics.FOREGROUND | LumaSplatsSemantics.BACKGROUND, bg: new Color(0x000000), text: 'Remove background' },
  { mask: LumaSplatsSemantics.FOREGROUND, bg: null, text: 'Background' }
];
let stateIndex = 1;

function applyStateForCurrent(sourceUrl) {
  if (!(currentObject instanceof LumaSplatsThree)) return;

  const MODEL_1 = 'https://lumalabs.ai/capture/afeec738-2a49-42bd-bd0b-fde2fd215d20';
  const MODEL_2 = 'https://lumalabs.ai/capture/8bb65c41-db69-4096-ad66-413283039e3b';
  const MODEL_3 = 'https://lumalabs.ai/capture/bbd433e8-9cad-4546-8be1-3f13d99f9584';

  const isM1 = sourceUrl === MODEL_1;
  const isM2 = sourceUrl === MODEL_2;
  const m1Height = 0.3;
  const m2Height = 0.8;

  if (isM1 && currentBgMode !== 'original') {
    currentObject.setShaderHooks({
      vertexShaderHooks: {
        getSplatTransform: /*glsl*/`
          (vec3 position, uint layersBitmask) {
            if (position.y > ${m1Height}) return mat4(0);
            return mat4(1.0);
          }
        `
      }
    });
  } else if (isM2 && currentBgMode === 'original') {
    currentObject.setShaderHooks({
      vertexShaderHooks: {
        getSplatTransform: /*glsl*/`
          (vec3 position, uint layersBitmask) {
            if (position.y > ${m2Height}) return mat4(0);
            return mat4(1.0);
          }
        `
      }
    });
  } else {
    currentObject.setShaderHooks({
      vertexShaderHooks: {
        getSplatTransform: /*glsl*/`
          (vec3 position, uint layersBitmask) {
            return mat4(1.0);
          }
        `
      }
    });
  }
}

// ---------- Fullscreen ----------
const fsBtn = document.getElementById('fullscreen-btn');
fsBtn?.addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.body.requestFullscreen().catch(e => console.error(e));
});

document.addEventListener('fullscreenchange', () => {
  if (fsBtn) fsBtn.textContent = document.fullscreenElement ? 'Exit Fullscreen' : 'Fullscreen';
  onResize();
});

// ---------- Link clicks ----------
document.querySelectorAll('a[data-src]').forEach(link => {
  link.addEventListener('click', (e) => {
    e.preventDefault();
    const url = e.currentTarget.getAttribute('data-src') || '';
    loadAny(url);
  });
});

// ---------- Resize ----------
function onResize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', onResize);
window.addEventListener('orientationchange', onResize);
onResize();

// ---------- XR Session ----------
renderer.xr.addEventListener('sessionstart', () => {
  inXR = true;
  controls.enabled = false;

  updateVRButtonLabel();

  yawTarget = 0; pitchTarget = 0;
  vrYaw = 0; vrPitch = 0;

  // Reset camera height offset on VR session start
  camHeightOffset = 0;
  camHeightTarget = 0;

  if (currentObject) placeObjectInFrontOfCamera(currentObject, 1.0);

  const session = renderer.xr.getSession();
  session?.requestReferenceSpace('local').then((refSpace) => {
    controls.update();
    const camPos = camera.getWorldPosition(new Vector3());
    const camQuat = camera.getWorldQuaternion(new Quaternion());
    const invQuat = camQuat.clone().invert();
    const invPos = camPos.clone().multiplyScalar(-1).applyQuaternion(invQuat);
    const transform = new XRRigidTransform(
      new DOMPointReadOnly(invPos.x, invPos.y, invPos.z, 1),
      new DOMPointReadOnly(invQuat.x, invQuat.y, invQuat.z, invQuat.w)
    );
    const offsetSpace = refSpace.getOffsetReferenceSpace(transform);
    renderer.xr.setReferenceSpace(offsetSpace);
  }).catch(() => {});
});

renderer.xr.addEventListener('sessionend', () => {
  inXR = false;
  endRotateWithController();
  controls.enabled = true;

  // Force a resize + projection update to avoid aspect/axis stretching
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();

  updateVRButtonLabel();
});


// ESC ends VR
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && renderer.xr.isPresenting) {
    const session = renderer.xr.getSession && renderer.xr.getSession();
    if (session) session.end().catch(() => {});
  }
});

// ---------- Main loop ----------
function mainLoop(time, frame) {
  if (inXR) {
    // Optional: enable to inspect handedness/axes
    // debugXRGamepads(time);

    updateControllerRotation();
    vrYaw += (yawTarget - vrYaw) * SMOOTH;
    vrPitch += (pitchTarget - vrPitch) * SMOOTH;
    if (currentObject) currentObject.rotation.set(vrPitch, vrYaw, 0);

    // Left controller: Y-axis controls distance (prefer handedness; fallback by index 0)
    let leftAxes = getControllerAxes('left');
    if (!leftAxes) leftAxes = getControllerAxesByIndex(0);
    if (leftAxes && Math.abs(leftAxes.y) > 0.15) {
      distanceTarget += (-leftAxes.y) * STICK_DIST_SENS;
      distanceTarget = Math.max(MIN_DIST, Math.min(MAX_DIST, distanceTarget));
    }

    // Right controller: X-axis triggers discrete 30° yaw steps (prefer handedness; fallback by index 1)
    let rightAxes = getControllerAxes('right');
    if (!rightAxes) rightAxes = getControllerAxesByIndex(1);
    if (rightAxes) {
      const x = rightAxes.x || 0;
      let step = 0;
      if (x > STEP_DEADZONE) step = +1;
      else if (x < -STEP_DEADZONE) step = -1;

      if (step !== 0 && lastRightStep === 0) {
        yawTarget += step * STEP_ANGLE;
      }

      if (Math.abs(x) < STEP_HYST) {
        lastRightStep = 0;
      } else {
        lastRightStep = step !== 0 ? step : lastRightStep;
      }

      // Right controller: Y-axis adjusts camera height target smoothly
      if (Math.abs(rightAxes.y) > 0.15) {
        // Push up (negative Y) raises, push down (positive Y) lowers
        camHeightTarget += (-rightAxes.y) * CAM_HEIGHT_SENS;
        camHeightTarget = Math.max(CAM_HEIGHT_MIN, Math.min(CAM_HEIGHT_MAX, camHeightTarget));
      }
    }

    // Smooth vertical offset toward target
    camHeightOffset += (camHeightTarget - camHeightOffset) * CAM_HEIGHT_SMOOTH;

    vrDistance += (distanceTarget - vrDistance) * DIST_SMOOTH;

    if (currentObject) {
      const xrCam = renderer.xr.getCamera ? renderer.xr.getCamera(camera) : camera;
      const camPos = new Vector3().setFromMatrixPosition(xrCam.matrixWorld);
      const forwardYaw = new Vector3(Math.sin(entryYaw), 0, -Math.cos(entryYaw));
      const targetPos = camPos.clone().add(forwardYaw.multiplyScalar(vrDistance));

      // Apply vertical offset controlled by right stick Y
      targetPos.y += camHeightOffset;

      currentObject.position.copy(targetPos);
      currentObject.updateMatrixWorld(true);
    }
  } else {
    controls.update();
  }
  renderer.render(scene, camera);
}
renderer.setAnimationLoop(mainLoop);
window.appMainLoop = mainLoop;

// ---------- VR button label helper ----------
function updateVRButtonLabel() {
  const el = document.getElementById('VRButton');
  if (!el) return;
  el.textContent = renderer.xr.isPresenting ? 'EXIT VR' : 'ENTER VR';
}

// ---------- Initial model ----------
loadAny('models/Affe_lowpoly_tris.obj');

// Ensure initial background button label is consistent
updateBgButtonLabel();
