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

const renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setClearColor(0x111111, 1);
renderer.outputColorSpace = SRGBColorSpace;
document.body.appendChild(renderer.domElement);

renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local');

if ('xr' in navigator) {
  navigator.xr.isSessionSupported('immersive-vr').then((supported) => {
    if (supported) {
      const vrButton = VRButton.createButton(renderer);
      vrButton.id = 'VRButton';
      document.body.appendChild(vrButton);
      vrButton.addEventListener('click', () => {
        if (renderer.xr.isPresenting) renderer.xr.end();
      });
    }
  }).catch(err => console.error("XR support check failed:", err));
}

const scene = new Scene();
scene.background = new Color(0x111);
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

// Controller
let inXR = false;

const controller0 = renderer.xr.getController(0);
const controller1 = renderer.xr.getController(1);
scene.add(controller0, controller1);

// Interaktionszustand
const ctrlState = {
  active: false,
  lastPos: new Vector3(),
  controller: null,
};

// Geführte VR-Winkel (Target) + geglättete aktuelle Winkel (für weiches Gefühl)
let yawTarget = 0, pitchTarget = 0;
let vrYaw = 0, vrPitch = 0;
const ROT_SENS = 1.6;            // Rotations-Empfindlichkeit
const MAX_PITCH = Math.PI * 0.49; // ~±88°
const SMOOTH = 0.18;             // 0..1, höher = schneller auf Target

// Thumbstick distance state (new)
let distanceTarget = 1.0;
let vrDistance = 1.0;
const MIN_DIST = 0.3;
const MAX_DIST = 3.5;
const DIST_SMOOTH = 0.18;
const STICK_DIST_SENS = 0.025;   // tune 0.015–0.05
let entryYaw = 0;                 // set at VR entry

controller0.addEventListener('selectstart', () => beginRotateWithController(controller0));
controller0.addEventListener('selectend', endRotateWithController);
controller1.addEventListener('selectstart', () => beginRotateWithController(controller1));
controller1.addEventListener('selectend', endRotateWithController);

// Optional zusätzlich Grip-Taste unterstützen:
controller0.addEventListener('squeezestart', () => beginRotateWithController(controller0));
controller0.addEventListener('squeezeend', endRotateWithController);
controller1.addEventListener('squeezestart', () => beginRotateWithController(controller1));
controller1.addEventListener('squeezeend', endRotateWithController);

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

let currentObject = null;
let currentIsSplat = false;
const bgBtn = document.getElementById('bg-toggle');

function removeCurrent() {
  if (!currentObject) return;
  scene.remove(currentObject);
  if (currentIsSplat && currentObject.dispose) {
    currentObject.dispose();
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
}

// Zentrieren & normalisieren auf Zielgröße
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

// Fit-to-view Kamera-Positionierung
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

function isLumaCapture(url) {
  return /lumalabs\.ai\/capture\//i.test(url);
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
  // XR-Kamera (oder Fallback)
  const xrCam = renderer.xr.getCamera ? renderer.xr.getCamera(camera) : camera;

  // Weltposition/-rotation der XR-Kamera
  const camPos = new Vector3().setFromMatrixPosition(xrCam.matrixWorld);
  const camQuat = new Quaternion().setFromRotationMatrix(xrCam.matrixWorld);

  // Blickrichtung (vorwärts)
  const forward = new Vector3(0, 0, -1).applyQuaternion(camQuat);

  // Zielposition: "distance" Meter vor der Kamera
  const targetPos = camPos.clone().add(forward.multiplyScalar(distance));

  // Objekt platzieren und „frontal“ ausrichten (nur Yaw)
  obj.position.copy(targetPos);
  const euler = new Euler().setFromQuaternion(camQuat, 'YXZ');
  obj.rotation.set(0, euler.y, 0);
  obj.updateMatrixWorld(true);

  // Winkel-Reset für stabile, geführte Rotation
  yawTarget = 0; pitchTarget = 0;
  vrYaw = 0; vrPitch = 0;

  // Initialize distance for thumbstick control
  distanceTarget = distance;
  vrDistance = distance;

  // Remember yaw at entry for world-stable forward/back (horizontal only)
  entryYaw = euler.y;
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

  // Zielwinkel erhöhen — stabile, geführte Winkel
  yawTarget   += delta.x * ROT_SENS;
  pitchTarget -= delta.y * ROT_SENS;

  // Pitch clampen
  pitchTarget = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, pitchTarget));

  ctrlState.lastPos.copy(currPos);
}

// Read thumbstick Y (either stick), with deadzone
function getThumbstickY() {
  const session = renderer.xr.getSession?.();
  if (!session) return 0;

  let y = 0;
  for (const src of session.inputSources) {
    const gp = src.gamepad;
    if (!gp || !gp.axes || gp.axes.length < 2) continue;

    const candidates = [];
    if (gp.axes.length >= 2) candidates.push(gp.axes[1]); // left Y
    if (gp.axes.length >= 4) candidates.push(gp.axes[3]); // right Y

    const localY = candidates.reduce((best, v) => Math.abs(v) > Math.abs(best) ? v : best, 0);
    const DZ = 0.15;
    if (Math.abs(localY) > Math.abs(y) && Math.abs(localY) > DZ) {
      y = localY;
    }
  }
  return y; // typically: up is negative
}

async function loadAny(url) {
  removeCurrent();

  const lower = url.toLowerCase();
  const ext = lower.split('.').pop();
  const normalizedExt = ext === 'glt' ? 'gltf' : ext;

  // Ladeanzeige aktivieren
  document.getElementById('loading').style.display = 'block';

  try {
    if (isLumaCapture(url)) {
      const splat = new LumaSplatsThree({ source: url });
      scene.add(splat);
      currentObject = splat;
      currentIsSplat = true;

      if (inXR && currentObject) {
        placeObjectInFrontOfCamera(currentObject, 1.0);
      }

      // BG-Button sichtbar für Luma
      bgBtn.classList.remove('hidden');

      camera.position.set(0, 0, 2);
      if (url === 'https://lumalabs.ai/capture/bbd433e8-9cad-4546-8be1-3f13d99f9584') {
        camera.position.y = -1;
      }
      camera.updateProjectionMatrix();
      controls.target.set(0, 0, 0);
      controls.update();

      // Ladeanzeige deaktivieren
      document.getElementById('loading').style.display = 'none';

      setTimeout(() => {
        applyStateForCurrent(url);
        updateLinkColors();
      }, 0);

      return;
    }

    let loaded = null;

    if (normalizedExt === 'gltf' || normalizedExt === 'glb') {
      const gltf = await new Promise((res, rej) => {
        new GLTFLoader().load(url, res, undefined, rej);
      });
      loaded = gltf.scene || gltf.scenes?.[0];

      if (lower.includes('bienenkasten.glb') || lower.includes('beehive')) {
        loaded.rotation.y = Math.PI / 1.1;
        loaded.rotation.x = Math.PI / 6;
      }

    } else if (normalizedExt === 'fbx') {
      loaded = await new Promise((res, rej) => {
        new FBXLoader().load(url, res, undefined, rej);
      });

    } else if (normalizedExt === 'obj') {
      const objLoader = new OBJLoader();
      const mtlLoader = new MTLLoader();
      const mtlUrl = url.replace('.obj', '.mtl');

      const materials = await new Promise((res, rej) => {
        mtlLoader.load(mtlUrl, res, undefined, rej);
      });
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
      const geom = await new Promise((res, rej) => {
        new STLLoader().load(url, res, undefined, rej);
      });
      const mat = new MeshStandardMaterial({ color: 0xcccccc, metalness: 0.1, roughness: 0.8 });
      loaded = new Mesh(geom, mat);

    } else if (normalizedExt === 'ply') {
      const geom = await new Promise((res, rej) => {
        new PLYLoader().load(url, res, undefined, rej);
      });
      geom.computeVertexNormals?.();
      const mat = new MeshStandardMaterial({ color: 0xcccccc, metalness: 0.1, roughness: 0.8 });
      loaded = new Mesh(geom, mat);

    } else {
      throw new Error(`Unsupported format: ${ext}`);
    }

    if (!loaded) throw new Error('Model loaded but no scene/object found');

    // Non-Luma: Hintergrund solide
    bgBtn.classList.add('hidden');
    renderer.setClearColor(0x000000, 1);
    scene.background = null;

    // WRAPPER: „neutrale“ Gruppe als Container
    const wrapper = new Group();
    wrapper.name = 'ModelWrapper';
    wrapper.add(loaded);

    // Materialien vorbereiten (Vertex Colors / Texturen / Normalen)
    wrapper.traverse((child) => prepareMeshMaterial(child));

    // Zentrieren & normalisieren am Wrapper
    centerAndNormalize(wrapper, 1.5);

    // Zur Szene hinzufügen und referenzieren
    scene.add(wrapper);
    currentObject = wrapper;
    currentIsSplat = false;

    if (inXR && currentObject) {
      placeObjectInFrontOfCamera(currentObject, 1.0);
    }

    // Automatisch passend einrahmen (nur außerhalb VR relevant)
    frameByBox(wrapper, 1.25);

    setTimeout(() => {
      applyStateForCurrent(url);
      updateLinkColors();
      document.getElementById('loading').style.display = 'none';
    }, 0);

  } catch (e) {
    console.error('Loading failed:', e);
    alert(`Failed to load model: ${e.message || e}`);
    document.getElementById('loading').style.display = 'none';
  }
}

const states = [
  { mask: LumaSplatsSemantics.FOREGROUND | LumaSplatsSemantics.BACKGROUND, bg: new Color(0x000000), text: 'Remove background' },
  { mask: LumaSplatsSemantics.FOREGROUND, bg: null, text: 'Background' }
];
let stateIndex = 1;

function applyStateForCurrent(sourceUrl) {
  const s = states[stateIndex];

  renderer.setClearColor(s.bg === null ? 0x000000 : s.bg, s.bg !== null ? 1 : 0);

  const bgBtnEl = document.getElementById('bg-toggle');
  bgBtnEl.textContent = s.text;

  if (!currentIsSplat || !currentObject) return;

  currentObject.semanticsMask = s.mask;

  const MODEL_1 = 'https://lumalabs.ai/capture/afeec738-2a49-42bd-bd0b-fde2fd215d20';
  const MODEL_2 = 'https://lumalabs.ai/capture/8bb65c41-db69-4096-ad66-413283039e3b';
  const MODEL_3 = 'https://lumalabs.ai/capture/bbd433e8-9cad-4546-8be1-3f13d99f9584';

  const isM1 = sourceUrl === MODEL_1;
  const isM2 = sourceUrl === MODEL_2;
  const isM3 = sourceUrl === MODEL_3;
  const bgOn = s.bg !== null;

  const m1Height = 0.3;
  const m2Height = 0.8;

  if (isM1 && !bgOn) {
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
  } else if (isM2 && bgOn) {
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

// BG-Toggle-Handler
document.getElementById('bg-toggle').addEventListener('click', () => {
  stateIndex = (stateIndex + 1) % states.length;
  applyStateForCurrent(currentIsSplat ? (currentObject?.source || '') : '');
  updateLinkColors();
});

// Fullscreen Button
const fsBtn = document.getElementById('fullscreen-btn');
fsBtn.addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.body.requestFullscreen().catch(e => console.error(e));
});

// Fullscreen-Änderung
document.addEventListener('fullscreenchange', () => {
  fsBtn.textContent = document.fullscreenElement ? 'Exit Fullscreen' : 'Fullscreen';
  onResize();
  updateLinkColors();
});

// Links klicken
document.querySelectorAll('a[data-src]').forEach(link => {
  link.addEventListener('click', (e) => {
    e.preventDefault();
    const url = e.currentTarget.getAttribute('data-src');
    loadAny(url);
  });
});

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

renderer.xr.addEventListener('sessionstart', () => {
  inXR = true;
  controls.enabled = false;

  // Winkel zurücksetzen für stabile Steuerung
  yawTarget = 0; pitchTarget = 0;
  vrYaw = 0; vrPitch = 0;

  // Einmalig vor den Betrachter platzieren (Welt-Raum), NICHT an Kamera binden
  if (currentObject) placeObjectInFrontOfCamera(currentObject, 1.0);

  // Optional: ReferenceSpace-Offset (kann weggelassen werden)
  const session = renderer.xr.getSession();
  session.requestReferenceSpace('local').then((refSpace) => {
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
  });
});

renderer.xr.addEventListener('sessionend', () => {
  inXR = false;
  endRotateWithController();
  controls.enabled = true;
});

// Animation-Loop mit Rotation + thumbstick distance
renderer.setAnimationLoop((time, frame) => {
  if (inXR) {
    updateControllerRotation();

    // Smooth angles
    vrYaw += (yawTarget - vrYaw) * SMOOTH;
    vrPitch += (pitchTarget - vrPitch) * SMOOTH;

    if (currentObject) {
      // Keep yaw relative to entry orientation (world-stable)
      currentObject.rotation.set(vrPitch, vrYaw, 0);
    }

    // Thumbstick forward/back (independent of grab)
    const stickY = getThumbstickY(); // up is typically negative
    if (stickY !== 0) {
      distanceTarget += (stickY) * STICK_DIST_SENS; // up -> closer
      distanceTarget = Math.max(MIN_DIST, Math.min(MAX_DIST, distanceTarget));
    }

    // Smooth distance
    vrDistance += (distanceTarget - vrDistance) * DIST_SMOOTH;

    // Recompute world position along entryYaw from current head position (horizontal only)
    if (currentObject) {
      const xrCam = renderer.xr.getCamera ? renderer.xr.getCamera(camera) : camera;
      const camPos = new Vector3().setFromMatrixPosition(xrCam.matrixWorld);
      const forwardYaw = new Vector3(Math.sin(entryYaw), 0, -Math.cos(entryYaw));
      const targetPos = camPos.clone().add(forwardYaw.multiplyScalar(vrDistance));
      currentObject.position.copy(targetPos);
      currentObject.updateMatrixWorld(true);
    }
  } else {
    controls.update();
  }
  renderer.render(scene, camera);
});

// Linkfarben-Logik
function updateLinkColors() {
  const linkContainer = document.querySelector('.link-container');
  if (!linkContainer) return;

  const isFullscreen = !!document.fullscreenElement;
  const bgState = states[stateIndex];
  const bgIsShown = (bgState.bg === null); // Background aktiv

  if (isFullscreen && bgIsShown) {
    linkContainer.classList.add('fullscreen-bg-on');
  } else {
    linkContainer.classList.remove('fullscreen-bg-on');
  }

  if (bgIsShown) {
    linkContainer.classList.add('bg-on');
  } else {
    linkContainer.classList.remove('bg-on');
  }
}

// Initiales Modell
// loadAny('https://lumalabs.ai/capture/afeec738-2a49-42bd-bd0b-fde2fd215d20');
loadAny('models/Affe_lowpoly_tris.obj');

// BG toggle initial verstecken (Nicht-Luma initial)
const bgBtnRef = document.getElementById('bg-toggle');
bgBtnRef.classList.add('hidden');

updateLinkColors();
