import {
  Bone,
  BufferGeometry,
  CanvasTexture,
  Color,
  CylinderGeometry,
  Float32BufferAttribute,
  Group,
  type Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  MeshStandardMaterial,
  Quaternion,
  Skeleton,
  SkinnedMesh,
  SphereGeometry,
  SRGBColorSpace,
  Vector3,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { acceleratedRaycast, MeshBVH } from 'three-mesh-bvh';
import { smoothstep } from '../../core/mathUtils';
import { createGloveInFistFrame, FAR_GLOVE_CELL, paintGlove } from '../../player/GloveModel';
import { CANONICAL_BONES, type BoneMap, type CanonicalBone, type HeadProxy, type HumanoidRig } from '../HumanoidRig';
import { MaskFaceRegions } from '../FaceRegions';
import {
  ARM_RINGS,
  ATLAS,
  BONE_REST,
  HEAD_CENTER,
  LEG_RINGS,
  LID_OPEN_ANGLE,
  NECK_RINGS,
  neckDisplacement,
  OPPONENT_HEIGHT,
  SHORTS_CROTCH_Y,
  TORSO_RINGS,
  torsoDisplacement,
} from './BodyLayout';
import {
  type AtlasRect,
  blendAcross,
  blendByHeight,
  type InfluenceFn,
  loftGeometry,
  placeLimb,
  rigid,
  SkinnedGeometryBuilder,
} from './geometryBuilders';
import { buildHeadGeometry, EYE_RADIUS, headUV } from './HeadModel';
import { buildFaceRegionMaps, paintEyeTexture, paintOpponentAlbedo } from './opponentTextures';
import { buildShortsGeometry } from './Shorts';

const GLOVE_COLOR = 0x1b2340;
const TRIM_COLOR = 0xe8e8e8;
const BOOT_COLOR = 0x161616;
const SOLE_COLOR = 0xd0d0d0;

type Side = 'Left' | 'Right';
const SIDES: readonly Side[] = ['Left', 'Right'];

/**
 * Builds the fallback opponent entirely from code (Section 3: "If no model
 * file is provided, generate a procedural fallback humanoid ... with the same
 * bone hierarchy"). One skeleton drives four skinned meshes: skin, shorts,
 * eyeballs and gear (gloves + boots).
 */
export function createProceduralHumanoid(textureSize: number): HumanoidRig {
  const root = new Group();
  root.name = 'opponent';

  // Skeleton ------------------------------------------------------------------
  const boneList: Bone[] = [];
  const boneIndex = new Map<CanonicalBone, number>();
  const bones: Partial<Record<CanonicalBone, Bone>> = {};
  for (const name of CANONICAL_BONES) {
    const bone = new Bone();
    bone.name = name;
    bones[name] = bone;
    boneIndex.set(name, boneList.length);
    boneList.push(bone);
  }
  for (const name of CANONICAL_BONES) {
    const rest = BONE_REST[name];
    const bone = bones[name] as Bone;
    if (rest.parent) {
      bone.position.subVectors(rest.position, BONE_REST[rest.parent].position);
      (bones[rest.parent] as Bone).add(bone);
    } else {
      bone.position.copy(rest.position);
      root.add(bone);
    }
  }
  root.updateMatrixWorld(true);
  const skeleton = new Skeleton(boneList);
  const idx = (name: CanonicalBone): number => boneIndex.get(name) as number;
  const rest = (name: CanonicalBone): Vector3 => BONE_REST[name].position;

  // Below the waist, the skin and the trunks share one weighting, so the trunks
  // move exactly with what is under them and never get poked through: the hips
  // carry everything near the crotch line, the thighs take over further down.
  const hipY = rest('LeftUpLeg').y;
  const underShorts: InfluenceFn = (p) => {
    const depth = smoothstep(-0.05, 0.07, hipY - p.y);
    const lateral = smoothstep(0, 0.03, Math.abs(p.x));
    const below = smoothstep(SHORTS_CROTCH_Y + 0.01, SHORTS_CROTCH_Y - 0.03, p.y);
    return [idx('Hips'), idx(p.x >= 0 ? 'LeftUpLeg' : 'RightUpLeg'), depth * (lateral + (1 - lateral) * below)];
  };
  const WAIST_Y = 0.99;

  // Skin ----------------------------------------------------------------------
  const skin = new SkinnedGeometryBuilder();

  const head = buildHeadGeometry();
  head.geometry.translate(HEAD_CENTER.x, HEAD_CENTER.y, HEAD_CENTER.z);
  skin.add(head.geometry, (_p, i) => [idx('Head'), idx('Jaw'), head.jawWeights[i]], ATLAS.head);
  const headProxyGeometry = head.geometry.clone();

  for (const side of SIDES) {
    const s = side === 'Left' ? 1 : -1;
    const ear = new SphereGeometry(1, 16, 12)
      .scale(0.011, 0.031, 0.02)
      .rotateX(-0.25)
      .rotateY(-0.35 * s)
      .translate(HEAD_CENTER.x + 0.078 * s, HEAD_CENTER.y - 0.006, HEAD_CENTER.z - 0.012);
    skin.add(ear, rigid(idx('Head')), side === 'Left' ? ATLAS.earLeft : ATLAS.earRight);
    skin.add(createUpperLid(rest(`${side}Eye`)), rigid(idx(`${side}UpperLid`)));
  }

  const neck = loftGeometry(NECK_RINGS, { segments: 28, displace: neckDisplacement });
  skin.add(neck, blendByHeight([idx('Spine2'), idx('Neck'), idx('Head')], [1.47, 1.575], 0.03), ATLAS.neck);

  const torso = loftGeometry(TORSO_RINGS, { segments: 48, capBottom: 0.01, capTop: 0.01, displace: torsoDisplacement });
  const torsoProxyGeometry = torso.clone();
  const torsoBlend = blendByHeight([idx('Hips'), idx('Spine'), idx('Spine1'), idx('Spine2'), idx('Neck')], [1.02, 1.12, 1.24, 1.47], 0.04);
  skin.add(torso, (p, i) => (p.y > WAIST_Y ? torsoBlend(p, i) : underShorts(p, i)), ATLAS.torso);

  for (const side of SIDES) {
    const shoulder = rest(`${side}Arm`);
    const elbow = rest(`${side}ForeArm`);
    const wrist = rest(`${side}Hand`);
    const arm = placeLimb(loftGeometry(ARM_RINGS, { segments: 20, capBottom: 0.005, capTop: 0.02 }), shoulder, wrist);
    const armDir = new Vector3().subVectors(wrist, shoulder).normalize();
    skin.add(
      arm,
      blendAcross(idx(`${side}Arm`), idx(`${side}ForeArm`), elbow, armDir, 0.035),
      side === 'Left' ? ATLAS.armLeft : ATLAS.armRight,
    );

    const hip = rest(`${side}UpLeg`);
    const knee = rest(`${side}Leg`);
    const ankle = rest(`${side}Foot`);
    const leg = placeLimb(loftGeometry(LEG_RINGS, { segments: 24, capBottom: 0.005, capTop: 0.02 }), hip, ankle);
    const legDir = new Vector3().subVectors(ankle, hip).normalize();
    const kneeBlend = blendAcross(idx(`${side}UpLeg`), idx(`${side}Leg`), knee, legDir, 0.04);
    skin.add(
      leg,
      (p, i) => (p.y > knee.y + 0.08 ? underShorts(p, i) : kneeBlend(p, i)),
      side === 'Left' ? ATLAS.legLeft : ATLAS.legRight,
    );
  }

  // Shorts --------------------------------------------------------------------
  // One continuous surface skinned by one function (shared with the skin
  // underneath), so the waist and legs always move together and stay closed.
  const shorts = new SkinnedGeometryBuilder();
  const trunks = buildShortsGeometry(rest('LeftUpLeg'), rest('LeftFoot'));
  const waistBlend = blendByHeight([idx('Hips'), idx('Spine')], [1.03], 0.04);
  const shortsInfluence: InfluenceFn = (p, i) => (p.y > WAIST_Y ? waistBlend(p, i) : underShorts(p, i));
  shorts.add(trunks.waist, shortsInfluence, ATLAS.shortsPelvis);
  shorts.add(trunks.left, shortsInfluence, ATLAS.shortsLegLeft);
  shorts.add(trunks.right, shortsInfluence, ATLAS.shortsLegRight);

  // Eyes ------------------------------------------------------------------------
  const eyes = new SkinnedGeometryBuilder();
  for (const side of SIDES) {
    const c = rest(`${side}Eye`);
    const ball = new SphereGeometry(EYE_RADIUS, 24, 16).rotateX(Math.PI / 2).translate(c.x, c.y, c.z);
    eyes.add(ball, rigid(idx(`${side}Eye`)));
  }

  // Gear: gloves and boots (vertex coloured) -------------------------------------
  const gear = new SkinnedGeometryBuilder();
  for (const side of SIDES) {
    const s = side === 'Left' ? 1 : -1;
    gear.add(createGlove(s, rest(`${side}ForeArm`), rest(`${side}Hand`)), rigid(idx(`${side}Hand`)));
    for (const part of createBoot(rest(`${side}Foot`))) {
      gear.add(part, rigid(idx(`${side}Foot`)));
    }
  }

  // Materials & meshes ----------------------------------------------------------
  const albedo = new CanvasTexture(paintOpponentAlbedo(textureSize));
  albedo.colorSpace = SRGBColorSpace;
  albedo.anisotropy = 4;
  const regionMaps = buildFaceRegionMaps(512);
  const zoneTexture = new CanvasTexture(regionMaps.zoneCanvas);
  zoneTexture.colorSpace = SRGBColorSpace;
  const eyeTexture = new CanvasTexture(paintEyeTexture());
  eyeTexture.colorSpace = SRGBColorSpace;

  const skinMaterial = new MeshStandardMaterial({ name: 'opponent-skin', map: albedo, roughness: 0.55, metalness: 0 });
  const shortsMaterial = new MeshStandardMaterial({ name: 'opponent-shorts', map: albedo, roughness: 0.38, metalness: 0 });
  const eyeMaterial = new MeshStandardMaterial({ name: 'opponent-eyes', map: eyeTexture, roughness: 0.06, metalness: 0 });
  const gearMaterial = new MeshStandardMaterial({ name: 'opponent-gear', vertexColors: true, roughness: 0.42, metalness: 0 });
  const zoneMaterial = new MeshLambertMaterial({ name: 'opponent-zones', map: zoneTexture });

  const makeMesh = (geometry: BufferGeometry, material: Material, name: string, castShadow = true): SkinnedMesh => {
    const mesh = new SkinnedMesh(geometry, material);
    mesh.name = name;
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    // A single character that is almost always in view; skip the skinned bounds update.
    mesh.frustumCulled = false;
    root.add(mesh);
    mesh.bind(skeleton, new Matrix4());
    return mesh;
  };
  const skinMesh = makeMesh(skin.build(), skinMaterial, 'opponent-skin');
  const shortsMesh = makeMesh(shorts.build(), shortsMaterial, 'opponent-shorts');
  const eyesMesh = makeMesh(eyes.build(), eyeMaterial, 'opponent-eyes', false);
  const gearMesh = makeMesh(gear.build(), gearMaterial, 'opponent-gear');
  const skinnedMeshes = [skinMesh, shortsMesh, eyesMesh, gearMesh];

  const proxy = (geometry: BufferGeometry, bone: CanonicalBone, name: string): HeadProxy => {
    const bvh = new MeshBVH(geometry);
    geometry.boundsTree = bvh;
    const mesh = new Mesh(geometry, new MeshBasicMaterial());
    mesh.name = name;
    mesh.matrixAutoUpdate = false;
    mesh.raycast = acceleratedRaycast;
    return { mesh, bone: bones[bone] as Bone, boneInverse: skeleton.boneInverses[idx(bone)], bindMatrix: skinMesh.bindMatrix, bvh };
  };
  const headProxy = proxy(headProxyGeometry, 'Head', 'opponent-head-proxy');
  const torsoProxy = proxy(torsoProxyGeometry, 'Spine1', 'opponent-torso-proxy');

  // The eyelids share the head's UVs: leave them out of painting so they aren't painted twice.
  const lidBones = new Set([idx('LeftUpperLid'), idx('RightUpperLid')]);
  const skinPaint = withoutBones(skinMesh.geometry, lidBones);

  let triangles = 0;
  for (const mesh of skinnedMeshes) triangles += (mesh.geometry.index?.count ?? 0) / 3;

  return {
    kind: 'procedural',
    root,
    bones: bones as BoneMap,
    skinnedMeshes,
    height: OPPONENT_HEIGHT,
    headCenter: HEAD_CENTER.clone(),
    handRadius: 0.07,
    headProxies: [headProxy],
    torsoProxies: [torsoProxy],
    paintSurfaces: [
      { paintGeometry: skinPaint, material: skinMaterial, cloth: false },
      { paintGeometry: shortsMesh.geometry, material: shortsMaterial, cloth: true },
    ],
    paintReference: skinMesh,
    paintCullDistance: maxEdgeLength([skinPaint, shortsMesh.geometry]) + 0.01,
    faceRegions: new MaskFaceRegions(regionMaps.mask, regionMaps.size),
    blinkMorphs: [],
    triangles,
    setZoneDebugView(enabled: boolean): void {
      skinMesh.material = enabled ? zoneMaterial : skinMaterial;
      shortsMesh.material = enabled ? zoneMaterial : shortsMaterial;
    },
  };
}

/** A view of `geometry` (sharing its attributes) without triangles skinned to the given bones. */
export function withoutBones(geometry: BufferGeometry, excluded: ReadonlySet<number>): BufferGeometry {
  const index = geometry.index;
  const skinIndex = geometry.getAttribute('skinIndex');
  if (!index || !skinIndex) return geometry;
  const kept: number[] = [];
  for (let i = 0; i < index.count; i += 3) {
    const tri = [index.getX(i), index.getX(i + 1), index.getX(i + 2)];
    if (tri.some((v) => excluded.has(skinIndex.getX(v)))) continue;
    kept.push(...tri);
  }
  const view = new BufferGeometry();
  view.setAttribute('position', geometry.getAttribute('position'));
  view.setAttribute('uv', geometry.getAttribute('uv'));
  view.setIndex(kept);
  return view;
}

/** Longest triangle edge across geometries (painter culling margin). */
export function maxEdgeLength(geometries: readonly BufferGeometry[]): number {
  let max = 0;
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  for (const g of geometries) {
    const pos = g.getAttribute('position');
    const index = g.index;
    const count = index ? index.count : pos.count;
    for (let i = 0; i < count; i += 3) {
      const ia = index ? index.getX(i) : i;
      const ib = index ? index.getX(i + 1) : i + 1;
      const ic = index ? index.getX(i + 2) : i + 2;
      a.fromBufferAttribute(pos, ia);
      b.fromBufferAttribute(pos, ib);
      c.fromBufferAttribute(pos, ic);
      max = Math.max(max, a.distanceTo(b), b.distanceTo(c), c.distanceTo(a));
    }
  }
  return max;
}

/**
 * Upper eyelid: a spherical cap just outside the eyeball, baked in the open
 * pose. The lid bone (at the eye centre) rotates it about X to blink. Its UVs
 * are projected onto the head atlas so bruising around the eye shows on the lid.
 */
function createUpperLid(eyeCenter: Vector3): BufferGeometry {
  const lid = new SphereGeometry(EYE_RADIUS + 0.0009, 28, 12, 0, Math.PI * 2, 0, (100 * Math.PI) / 180);
  lid.rotateX(LID_OPEN_ANGLE).translate(eyeCenter.x, eyeCenter.y, eyeCenter.z);
  const pos = lid.getAttribute('position');
  const uv = lid.getAttribute('uv');
  const a: AtlasRect = ATLAS.head;
  for (let i = 0; i < pos.count; i++) {
    const [u, v] = headUV(pos.getX(i) - HEAD_CENTER.x, pos.getY(i) - HEAD_CENTER.y);
    uv.setXY(i, a.u0 + u * a.w, a.v0 + v * a.h);
  }
  return lid;
}

function withColor(geometry: BufferGeometry, hex: number): BufferGeometry {
  const c = new Color(hex);
  const count = geometry.getAttribute('position').count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) colors.set([c.r, c.g, c.b], i * 3);
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 3));
  return geometry;
}

/** Where the wrist sits along the player's glove model (fist frame z). */
const WRIST_IN_GLOVE = 0.065;

/**
 * The player's glove model (meshed coarser) on the hand bone: in the rest pose
 * the knuckles point down the forearm, the back of the hand faces out and the
 * thumb forward; the cuff runs up the forearm. Moved into character rest space.
 */
function createGlove(side: 1 | -1, elbow: Vector3, wrist: Vector3): BufferGeometry {
  const glove = createGloveInFistFrame(side === 1 ? 'left' : 'right', 12, FAR_GLOVE_CELL);
  paintGlove(glove, GLOVE_COLOR, TRIM_COLOR);
  // Fist frame (punch -Z, back of hand +Y, thumb on the mirrored side) -> hand space hanging along -Y.
  const fistToHand = new Matrix4()
    .makeBasis(new Vector3(0, 0, side), new Vector3(side, 0, 0), new Vector3(0, 1, 0))
    .setPosition(0, -WRIST_IN_GLOVE, 0);
  const dir = new Vector3().subVectors(wrist, elbow).normalize();
  const q = new Quaternion().setFromUnitVectors(new Vector3(0, -1, 0), dir);
  glove.applyMatrix4(fistToHand).applyMatrix4(new Matrix4().compose(wrist, q, new Vector3(1, 1, 1)));
  // The gear mesh is merged with UV-mapped parts.
  glove.setAttribute('uv', new Float32BufferAttribute(new Float32Array(glove.getAttribute('position').count * 2), 2));
  return glove;
}

/** Boxing boot around the ankle joint. */
function createBoot(ankle: Vector3): BufferGeometry[] {
  const at = (x: number, y: number, z: number): [number, number, number] => [ankle.x + x, ankle.y + y, ankle.z + z];
  return [
    withColor(new RoundedBoxGeometry(0.105, 0.028, 0.275, 2, 0.012).translate(...at(0, -0.071, 0.05)), SOLE_COLOR),
    withColor(new RoundedBoxGeometry(0.098, 0.08, 0.255, 3, 0.035).translate(...at(0, -0.03, 0.045)), BOOT_COLOR),
    withColor(new CylinderGeometry(0.05, 0.053, 0.15, 18).translate(...at(0, 0.04, -0.01)), BOOT_COLOR),
  ];
}
