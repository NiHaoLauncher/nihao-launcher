// A Bedrock `.animation.json` (what Blockbench exports): per-bone keyframes, sampled by time.
export type Vec = [number, number, number];

/** One keyframe: the value just before and just after it (they differ only for a "jump"). */
interface Key { time: number; pre: Vec; post: Vec; smooth: boolean }

export interface BoneTracks { name: string; rotation?: Key[]; position?: Key[]; scale?: Key[] }

export interface Clip { length: number; loop: boolean; bones: BoneTracks[] }

/** What a bone does at one moment; a missing part means the clip leaves it alone. */
export interface Pose { rotation?: Vec; position?: Vec; scale?: Vec }

const toVec = (v: unknown): Vec => {
  const list = (Array.isArray(v) ? v : [v, v, v]).map(Number);
  return [list[0], list[1], list[2]];
};

/** A track is a constant (`[x, y, z]`) or keyframes keyed by time in seconds. */
function parseTrack(raw: any): Key[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "number" || Array.isArray(raw)) return [{ time: 0, pre: toVec(raw), post: toVec(raw), smooth: false }];
  return Object.entries<any>(raw)
    .map(([time, value]) => {
      const plain = typeof value === "number" || Array.isArray(value);
      return {
        time: Number(time),
        pre: toVec(plain ? value : value.pre ?? value.post),
        post: toVec(plain ? value : value.post ?? value.pre),
        smooth: !plain && value.lerp_mode === "catmullrom",
      };
    })
    .sort((a, b) => a.time - b.time);
}

/** The first animation in a Bedrock animation file. */
export function parseClip(json: any): Clip {
  const raw = Object.values<any>(json.animations)[0];
  const bones = Object.entries<any>(raw.bones ?? {}).map(([name, bone]) => ({
    name,
    rotation: parseTrack(bone.rotation),
    position: parseTrack(bone.position),
    scale: parseTrack(bone.scale),
  }));
  return { length: Number(raw.animation_length) || 0, loop: raw.loop === true, bones };
}

/** Uniform Catmull-Rom through `p1` and `p2`, with `p0` and `p3` shaping the curve. */
function catmullRom(p0: number, p1: number, p2: number, p3: number, u: number): number {
  return 0.5 * (2 * p1 + (p2 - p0) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u * u + (3 * p1 - p0 - 3 * p2 + p3) * u * u * u);
}

function sample(keys: Key[], time: number): Vec {
  const last = keys[keys.length - 1];
  if (time <= keys[0].time) return keys[0].post;
  if (time >= last.time) return last.post;
  let i = 0;
  while (keys[i + 1].time <= time) i++;
  const a = keys[i];
  const b = keys[i + 1];
  const u = (time - a.time) / (b.time - a.time);
  if (!(a.smooth || b.smooth)) return a.post.map((v, n) => v + (b.pre[n] - v) * u) as Vec;
  const p0 = (keys[i - 1] ?? a).post;
  const p3 = (keys[i + 2] ?? b).post;
  return a.post.map((v, n) => catmullRom(p0[n], v, b.pre[n], p3[n], u)) as Vec;
}

/** Every animated bone's pose `progress` seconds into the clip (looping if the clip does). */
export function poseAt(clip: Clip, progress: number): Map<string, Pose> {
  const time = clip.length > 0 ? (clip.loop ? progress % clip.length : Math.min(progress, clip.length)) : 0;
  const poses = new Map<string, Pose>();
  for (const bone of clip.bones) {
    poses.set(bone.name, {
      rotation: bone.rotation && sample(bone.rotation, time),
      position: bone.position && sample(bone.position, time),
      scale: bone.scale && sample(bone.scale, time),
    });
  }
  return poses;
}
