import {
  type Bone,
  Box3,
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  ImageLoader,
  type Material,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  type MeshStandardMaterial,
  type SkinnedMesh,
  Vector3,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { acceleratedRaycast, MeshBVH } from 'three-mesh-bvh';
import { GeometricFaceRegions, type FaceRegionLookup, MaskFaceRegions } from './FaceRegions';
import {
  type BlinkMorphs,
  type BoneMap,
  CANONICAL_BONES,
  type CanonicalBone,
  type HeadProxy,
  type HumanoidRig,
  type PaintSurface,
  REQUIRED_BONES,
  type SurfaceProxy,
} from './HumanoidRig';
import type { OpponentConfig } from './OpponentConfig';
import { maxEdgeLength } from './procedural/ProceduralHumanoid';

const BLINK_LEFT = ['eyeBlinkLeft', 'eyeBlink_L', 'EyeBlink_L', 'blink_L', 'Blink_L', 'Fcl_EYE_Close_L'];
const BLINK_RIGHT = ['eyeBlinkRight', 'eyeBlink_R', 'EyeBlink_R', 'blink_R', 'Blink_R', 'Fcl_EYE_Close_R'];

function normalizeBoneName(name: string): string {
  return name.replace(/^mixamorig\d*[:_]?/i, '').toLowerCase();
}

/**
 * Loads a rigged humanoid GLB and maps it onto the canonical rig. Scales it
 * to the configured height with the feet on the floor, facing +Z.
 */
export async function loadGLBHumanoid(config: OpponentConfig, url: string): Promise<HumanoidRig> {
  const gltf = await new GLTFLoader().loadAsync(url);
  const model = gltf.scene;
  model.rotation.y = config.yaw;
  const root = new Group();
  root.name = 'opponent';
  root.add(model);

  const skinnedMeshes: SkinnedMesh[] = [];
  const bonesByName = new Map<string, Bone>();
  model.traverse((obj) => {
    if ((obj as SkinnedMesh).isSkinnedMesh) skinnedMeshes.push(obj as SkinnedMesh);
    if ((obj as Bone).isBone) bonesByName.set(normalizeBoneName(obj.name), obj as Bone);
  });
  if (skinnedMeshes.length === 0) throw new Error(`${url}: no skinned mesh found`);

  // Map canonical bones through the alias table.
  const bones: Partial<Record<CanonicalBone, Bone>> = {};
  for (const canonical of CANONICAL_BONES) {
    for (const candidate of [canonical, ...(config.boneAliases[canonical] ?? [])]) {
      const bone = bonesByName.get(normalizeBoneName(candidate));
      if (bone) {
        bones[canonical] = bone;
        break;
      }
    }
  }
  const missing = REQUIRED_BONES.filter((b) => !bones[b]);
  if (missing.length > 0) throw new Error(`${url}: missing required bones: ${missing.join(', ')}`);

  // Normalise size and put the feet on the floor.
  root.updateMatrixWorld(true);
  const box = new Box3().setFromObject(model);
  const scale = config.height / Math.max(0.01, box.max.y - box.min.y);
  model.scale.multiplyScalar(scale);
  model.position.y -= box.min.y * scale;
  root.updateMatrixWorld(true);

  const s = config.height / 1.8;
  const head = bones.Head as Bone;
  const headCenter = estimateHeadCenter(bones, s);

  const faceRegions: FaceRegionLookup = config.faceRegionMaskUrl
    ? MaskFaceRegions.fromImage(await new ImageLoader().loadAsync(config.faceRegionMaskUrl))
    : new GeometricFaceRegions(headCenter, s);

  const headBones = new Set<Bone>([head]);
  for (const name of ['Jaw', 'LeftEye', 'RightEye'] as const) if (bones[name]) headBones.add(bones[name] as Bone);
  const torsoBones = new Set<Bone>();
  for (const name of ['Spine', 'Spine1', 'Spine2'] as const) if (bones[name]) torsoBones.add(bones[name] as Bone);
  const headProxies: HeadProxy[] = [];
  const torsoProxies: SurfaceProxy[] = [];
  for (const mesh of skinnedMeshes) {
    const proxy = extractProxy(mesh, headBones, head);
    if (proxy) headProxies.push(proxy);
    const torso = extractProxy(mesh, torsoBones, bones.Spine1 ?? bones.Spine);
    if (torso) torsoProxies.push(torso);
  }

  // Paint every skinned mesh through its own UVs; clothing-like materials absorb blood as cloth.
  const paintMeshes = skinnedMeshes.filter((m) => !Array.isArray(m.material) && (m.material as Material).type === 'MeshStandardMaterial');
  const paintReference = paintMeshes.reduce((a, b) => (count(b) > count(a) ? b : a), paintMeshes[0] ?? skinnedMeshes[0]);
  const paintSurfaces: PaintSurface[] = paintMeshes.map((m) => ({
    paintGeometry: m.geometry,
    material: m.material as MeshStandardMaterial,
    cloth: /cloth|shirt|short|pant|outfit|trouser|top|bottom/i.test(`${m.name} ${(m.material as Material).name}`),
  }));

  const blinkMorphs: BlinkMorphs[] = [];
  let triangles = 0;
  const originalMaterials = new Map<SkinnedMesh, Material | Material[]>();
  for (const mesh of skinnedMeshes) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    originalMaterials.set(mesh, mesh.material);
    const g = mesh.geometry;
    triangles += (g.index ? g.index.count : g.getAttribute('position').count) / 3;
    const dict = mesh.morphTargetDictionary;
    if (dict) {
      const left = BLINK_LEFT.map((n) => dict[n]).find((i) => i !== undefined);
      const right = BLINK_RIGHT.map((n) => dict[n]).find((i) => i !== undefined);
      if (left !== undefined && right !== undefined) blinkMorphs.push({ mesh, left, right });
    }
  }

  // No zone atlas exists for arbitrary models: show the body as translucent grey
  // so the colour-coded hitboxes stand out.
  const xray = new MeshLambertMaterial({ color: 0x9aa0a8, transparent: true, opacity: 0.45, depthWrite: false });

  return {
    kind: 'glb',
    root,
    bones: bones as BoneMap,
    skinnedMeshes,
    height: config.height,
    headCenter,
    handRadius: 0.05 * s,
    headProxies,
    torsoProxies,
    paintSurfaces,
    paintReference,
    paintCullDistance: maxEdgeLength(paintSurfaces.map((p) => p.paintGeometry)) + 0.01,
    faceRegions,
    blinkMorphs,
    triangles,
    setZoneDebugView(enabled: boolean): void {
      for (const mesh of skinnedMeshes) mesh.material = enabled ? xray : (originalMaterials.get(mesh) as Material);
    },
  };
}

/**
 * Skull centre at eye level in character rest space. Called while the rig
 * root is still at the origin, so world positions are character space.
 */
function estimateHeadCenter(bones: Partial<Record<CanonicalBone, Bone>>, s: number): Vector3 {
  const toChar = (b: Bone): Vector3 => b.getWorldPosition(new Vector3());
  if (bones.LeftEye && bones.RightEye) {
    const c = toChar(bones.LeftEye).add(toChar(bones.RightEye)).multiplyScalar(0.5);
    c.z -= 0.075 * s;
    return c;
  }
  return toChar(bones.Head as Bone).add(new Vector3(0, 0.085 * s, 0.02 * s));
}

function count(mesh: SkinnedMesh): number {
  return mesh.geometry.getAttribute('position').count;
}

/**
 * Copies the triangles that are mostly skinned to a set of bones into a static
 * bind-space mesh with a BVH, for fast raycasts and blood flow (avoids
 * CPU-skinning the whole body). Posed with `mainBone`'s skinning matrix.
 */
function extractProxy(mesh: SkinnedMesh, partBones: Set<Bone>, mainBone: Bone | undefined): HeadProxy | null {
  if (!mainBone) return null;
  const skeletonBones = mesh.skeleton.bones;
  const headIndex = skeletonBones.indexOf(mainBone);
  if (headIndex < 0) return null;
  const isHead = skeletonBones.map((b) => partBones.has(b));

  const g = mesh.geometry;
  const pos = g.getAttribute('position');
  const uv = g.getAttribute('uv');
  const si = g.getAttribute('skinIndex');
  const sw = g.getAttribute('skinWeight');
  if (!si || !sw) return null;

  const headWeight = (v: number): number => {
    let w = 0;
    for (let k = 0; k < 4; k++) if (isHead[si.getComponent(v, k)]) w += sw.getComponent(v, k);
    return w;
  };

  const outPos: number[] = [];
  const outUv: number[] = [];
  const triCount = (g.index ? g.index.count : pos.count) / 3;
  for (let t = 0; t < triCount; t++) {
    const tri = [0, 1, 2].map((k) => (g.index ? g.index.getX(t * 3 + k) : t * 3 + k));
    if (!tri.every((v) => headWeight(v) >= 0.5)) continue;
    for (const v of tri) {
      outPos.push(pos.getX(v), pos.getY(v), pos.getZ(v));
      outUv.push(uv ? uv.getX(v) : 0, uv ? uv.getY(v) : 0);
    }
  }
  if (outPos.length === 0) return null;

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(outPos, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(outUv, 2));
  const bvh = new MeshBVH(geometry);
  geometry.boundsTree = bvh;
  const proxy = new Mesh(geometry, new MeshBasicMaterial());
  proxy.matrixAutoUpdate = false;
  proxy.raycast = acceleratedRaycast;
  return { mesh: proxy, bone: mainBone, boneInverse: mesh.skeleton.boneInverses[headIndex], bindMatrix: mesh.bindMatrix, bvh };
}
