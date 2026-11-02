import type { CanonicalBone } from './HumanoidRig';

/**
 * Opponent model configuration (Section 3: "any standard humanoid GLB can be
 * swapped in via a config file that maps bone names").
 *
 * To use your own model: drop it in `public/assets/models/` and set `modelUrl`
 * (or open the game with `?model=/assets/models/your.glb`). Bone names are
 * matched case-insensitively against the aliases below after stripping a
 * Mixamo `mixamorig:` prefix. If the file is missing or fails to load, the
 * procedural humanoid is used instead.
 */
export interface OpponentConfig {
  /** GLB to load, or null to always use the procedural opponent. */
  readonly modelUrl: string | null;
  /**
   * Optional face-region ID mask in the model's UV space (PNG; red channel =
   * region code × 16, see FaceRegions.HEAD_REGION_CODES). Without it, face
   * regions are classified geometrically around the head bone.
   */
  readonly faceRegionMaskUrl: string | null;
  /** The model is scaled to this standing height in metres. */
  readonly height: number;
  /** Extra yaw (radians) if the model does not face +Z. */
  readonly yaw: number;
  /** Candidate bone names per canonical bone (the canonical name itself is always tried first). */
  readonly boneAliases: Readonly<Partial<Record<CanonicalBone, readonly string[]>>>;
}

const params = new URLSearchParams(window.location.search);

export const OPPONENT_CONFIG: OpponentConfig = {
  modelUrl: params.get('model'),
  faceRegionMaskUrl: params.get('faceMask'),
  height: 1.8,
  yaw: 0,
  // Mixamo / Ready Player Me use the canonical names; these cover Unreal (UE4/5 mannequin) and VRM.
  boneAliases: {
    Hips: ['pelvis', 'J_Bip_C_Hips'],
    Spine: ['spine_01', 'J_Bip_C_Spine'],
    Spine1: ['spine_02', 'J_Bip_C_Chest'],
    Spine2: ['spine_03', 'J_Bip_C_UpperChest', 'Chest', 'UpperChest'],
    Neck: ['neck_01', 'J_Bip_C_Neck'],
    Head: ['head', 'J_Bip_C_Head'],
    Jaw: ['jaw', 'J_Bip_C_Jaw'],
    LeftEye: ['eye_l', 'J_Adj_L_FaceEye'],
    RightEye: ['eye_r', 'J_Adj_R_FaceEye'],
    LeftShoulder: ['clavicle_l', 'J_Bip_L_Shoulder'],
    LeftArm: ['upperarm_l', 'J_Bip_L_UpperArm', 'LeftUpperArm'],
    LeftForeArm: ['lowerarm_l', 'J_Bip_L_LowerArm', 'LeftLowerArm'],
    LeftHand: ['hand_l', 'J_Bip_L_Hand'],
    LeftHandTip: ['LeftHandMiddle1', 'middle_01_l', 'J_Bip_L_Middle1'],
    RightShoulder: ['clavicle_r', 'J_Bip_R_Shoulder'],
    RightArm: ['upperarm_r', 'J_Bip_R_UpperArm', 'RightUpperArm'],
    RightForeArm: ['lowerarm_r', 'J_Bip_R_LowerArm', 'RightLowerArm'],
    RightHand: ['hand_r', 'J_Bip_R_Hand'],
    RightHandTip: ['RightHandMiddle1', 'middle_01_r', 'J_Bip_R_Middle1'],
    LeftUpLeg: ['thigh_l', 'J_Bip_L_UpperLeg', 'LeftUpperLeg'],
    LeftLeg: ['calf_l', 'J_Bip_L_LowerLeg', 'LeftLowerLeg'],
    LeftFoot: ['foot_l', 'J_Bip_L_Foot'],
    LeftToeBase: ['ball_l', 'J_Bip_L_ToeBase', 'LeftToes'],
    RightUpLeg: ['thigh_r', 'J_Bip_R_UpperLeg', 'RightUpperLeg'],
    RightLeg: ['calf_r', 'J_Bip_R_LowerLeg', 'RightLowerLeg'],
    RightFoot: ['foot_r', 'J_Bip_R_Foot'],
    RightToeBase: ['ball_r', 'J_Bip_R_ToeBase', 'RightToes'],
  },
};
