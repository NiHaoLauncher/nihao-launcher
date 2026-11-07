// A small three.js viewer for Bedrock entity models (`.geo.json`): the bones and cubes of the
// geometry with a skin texture on them, an optional Bedrock animation, and a camera that only
// turns round the model. Not a general Bedrock renderer: no per-cube rotation, mirror or Molang.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Clip, Pose, Vec, poseAt } from "./bedrockAnimation";

const DEG = Math.PI / 180;

const FOV = 30;
/** The camera's angle from straight up: a touch above eye level. */
const POLAR = 1.45;
/**
 * What has to fit in the view, in model units, and the height the camera aims at. With the island
 * (the big stage) it is the player and the island under it, the wider of the two; without it (a
 * tile) just the player.
 */
const FIT_STAGE = { height: 56, width: 36, aimY: 11 };
const FIT_PLAYER = { height: 40, width: 20, aimY: 16 };

/** How far, in skin pixels, a face's texture region is pulled in from its edge. */
const EDGE_INSET = 0.02;

// Blockbench plays an animation on a scene facing -Z, turning Bedrock's X and Y rotation and its X
// position as it draws a bone (-X, -Y, +Z and -X, +Y, +Z). This scene is that one turned half way
// round the Y axis (the skin's front is +Z), which flips X and Z in both. Flip a sign if a limb
// moves the wrong way.
const ROT_SIGN: Vec = [1, -1, -1];
const POS_SIGN: Vec = [1, 1, -1];

type FaceName = "north" | "south" | "east" | "west" | "up" | "down";

interface Cube { origin: Vec; size: Vec; inflate: number; uv: any }
interface BoneDef { name: string; parent?: string; pivot: Vec; rotation: Vec; cubes: Cube[] }

/** A bone built into the scene, with the transform it rests at. */
interface Bone { group: THREE.Group; rest: Vec; rotation: Vec }

/** Where a face's texture region is on the skin, in pixels. */
function faceRect(cube: Cube, face: FaceName): [number, number, number, number] | null {
  const [w, h, d] = cube.size;
  if (Array.isArray(cube.uv)) {
    const [u, v] = cube.uv;
    switch (face) {
      // The skin's front is on the +Z face, so the character's right (-X) limbs show on the left
      // of a viewer facing it.
      case "south": return [u + d, v + d, w, h];
      case "west": return [u, v + d, d, h];
      case "north": return [u + d + w + d, v + d, w, h];
      case "east": return [u + d + w, v + d, d, h];
      case "up": return [u + d, v, w, d];
      case "down": return [u + d + w, v, w, d];
    }
  }
  const f = cube.uv?.[face];
  return f ? [f.uv[0], f.uv[1], f.uv_size[0], f.uv_size[1]] : null;
}

/** The four corners of a face, as the image on it reads from outside: top-left, top-right, bottom-right, bottom-left. */
function faceCorners(face: FaceName, min: Vec, max: Vec): Vec[] {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  switch (face) {
    case "north": return [[x1, y1, z0], [x0, y1, z0], [x0, y0, z0], [x1, y0, z0]];
    case "south": return [[x0, y1, z1], [x1, y1, z1], [x1, y0, z1], [x0, y0, z1]];
    case "east": return [[x1, y1, z1], [x1, y1, z0], [x1, y0, z0], [x1, y0, z1]];
    case "west": return [[x0, y1, z0], [x0, y1, z1], [x0, y0, z1], [x0, y0, z0]];
    case "up": return [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]];
    case "down": return [[x0, y0, z1], [x1, y0, z1], [x1, y0, z0], [x0, y0, z0]];
  }
}

const FACES: FaceName[] = ["north", "south", "east", "west", "up", "down"];

function parseBones(geometry: any, slim: boolean): { bones: BoneDef[]; texture: [number, number] } {
  const geo = geometry["minecraft:geometry"][0];
  const bones: BoneDef[] = (geo.bones ?? []).map((bone: any) => ({
    name: bone.name,
    parent: bone.parent,
    pivot: (bone.pivot ?? [0, 0, 0]) as Vec,
    rotation: (bone.rotation ?? [0, 0, 0]) as Vec,
    cubes: (bone.cubes ?? []).map((cube: any) => {
      const origin = [...cube.origin] as Vec;
      const size = [...cube.size] as Vec;
      // Slim arms are a pixel narrower; the right one keeps its outer edge, so it moves in.
      if (slim && /arm/i.test(bone.name)) {
        size[0] = 3;
        if (/right/i.test(bone.name)) origin[0] += 1;
      }
      return { origin, size, inflate: cube.inflate ?? 0, uv: cube.uv };
    }),
  }));
  return { bones, texture: [geo.description.texture_width, geo.description.texture_height] };
}

/** One mesh for all of a bone's cubes, its vertices relative to the bone's pivot. */
function buildMesh(def: BoneDef, texture: [number, number], material: THREE.Material): THREE.Mesh | null {
  const positions: number[] = [];
  const uvs: number[] = [];
  for (const cube of def.cubes) {
    const min = cube.origin.map((v, i) => v - cube.inflate - def.pivot[i]) as Vec;
    const max = cube.origin.map((v, i) => v + cube.size[i] + cube.inflate - def.pivot[i]) as Vec;
    for (const face of FACES) {
      const rect = faceRect(cube, face);
      if (!rect) continue;
      const [u, v, w, h] = rect;
      const [tl, tr, br, bl] = faceCorners(face, min, max);
      // Pulled in a hair from the region's edge: sampling exactly on it can pick the neighbouring
      // region's pixel and draw a thin stray line along the face.
      const e = EDGE_INSET;
      const uv = (px: number, py: number) => [px / texture[0], 1 - py / texture[1]];
      const [uTL, uTR, uBR, uBL] = [uv(u + e, v + e), uv(u + w - e, v + e), uv(u + w - e, v + h - e), uv(u + e, v + h - e)];
      positions.push(...tl, ...bl, ...br, ...tl, ...br, ...tr);
      uvs.push(...uTL, ...uBL, ...uBR, ...uTL, ...uBR, ...uTR);
    }
  }
  if (positions.length === 0) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  return new THREE.Mesh(geometry, material);
}

/**
 * A small floating island of 2-unit blocks: a grass top with a ragged edge over dirt that narrows
 * to stone underneath, a few rocks on top. Its top is the floor the model stands on (y = 0).
 */
function floatingIsland(): THREE.Group {
  // Pseudo-random in [0, 1) from a cell, so the island looks the same every time.
  const noise = (x: number, z: number, y: number) => {
    const v = Math.sin(x * 12.9898 + z * 78.233 + y * 37.719) * 43758.5453;
    return v - Math.floor(v);
  };
  const layers = [
    { radius: 8, colors: [0x5a9c3c, 0x4f8f34, 0x66a845] },
    { radius: 7, colors: [0x8a5a36, 0x7d5030, 0x946141] },
    { radius: 5.8, colors: [0x7d5030, 0x6f4728] },
    { radius: 4.6, colors: [0x6f4728, 0x7a7a7a] },
    { radius: 3.4, colors: [0x6a6a6a, 0x7a7a7a] },
    { radius: 2.2, colors: [0x6a6a6a, 0x5c5c5c] },
    { radius: 1.2, colors: [0x5c5c5c, 0x6a6a6a] },
  ];
  const cells: { x: number; y: number; z: number; color: number }[] = [];
  const rocks: { x: number; z: number }[] = [];
  layers.forEach(({ radius, colors }, layer) => {
    for (let cx = -10; cx <= 10; cx++) {
      for (let cz = -10; cz <= 10; cz++) {
        const distance = Math.hypot(cx, cz);
        if (distance > radius + (noise(cx, cz, layer) - 0.5) * 1.4) continue;
        cells.push({ x: cx * 2, y: -1 - layer * 2, z: cz * 2, color: colors[Math.floor(noise(cz, cx, layer + 7) * colors.length)] });
        if (layer === 0 && distance > 3.5 && noise(cx, cz, 99) > 0.9) rocks.push({ x: cx * 2, z: cz * 2 });
      }
    }
  });

  const island = new THREE.Group();
  const blocks = new THREE.InstancedMesh(new THREE.BoxGeometry(2, 2, 2), new THREE.MeshLambertMaterial({ color: 0xffffff }), cells.length);
  const at = new THREE.Object3D();
  cells.forEach((cell, i) => {
    at.position.set(cell.x, cell.y, cell.z);
    at.updateMatrix();
    blocks.setMatrixAt(i, at.matrix);
    blocks.setColorAt(i, new THREE.Color(cell.color));
  });
  island.add(blocks);
  for (const rock of rocks) {
    const stone = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.4, 1.4), new THREE.MeshLambertMaterial({ color: 0x8a8a8a }));
    stone.position.set(rock.x, 0.7, rock.z);
    island.add(stone);
  }
  return island;
}

/** A soft dark spot on the floor under the model, so it follows the feet at any size. */
function floorShadow(): THREE.Mesh {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, "rgba(0,0,0,0.55)");
  gradient.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 128, 128);
  const material = new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true, depthWrite: false });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(22, 22), material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.05;
  return mesh;
}

export class BedrockViewer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  /** Turns the model a little towards the viewer; the camera's own turning doesn't touch it. */
  private wrapper = new THREE.Group();
  private model = new THREE.Group();
  private material = new THREE.MeshBasicMaterial({ transparent: true, alphaTest: 0.1 });
  private bones = new Map<string, Bone>();
  private clip: Clip | null = null;
  private playing = true;
  private fitting = FIT_PLAYER;
  private progress = 0;
  private last = performance.now();
  private frame = 0;

  constructor(canvas: HTMLCanvasElement, width: number, height: number, interactive: boolean) {
    // No MSAA: it samples the skin just outside a face along the silhouette and draws a dark fringe
    // there. Drawing at double size and letting the page scale it down smooths the edges instead.
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: false });
    this.renderer.setPixelRatio(Math.max(window.devicePixelRatio, 2));
    this.renderer.setSize(width, height, false);

    this.camera = new THREE.PerspectiveCamera(FOV, width / height, 1, 500);
    this.controls = new OrbitControls(this.camera, canvas);
    this.fitting = interactive ? FIT_STAGE : FIT_PLAYER;
    this.controls.target.set(0, this.fitting.aimY, 0);
    this.controls.enableZoom = false;
    this.controls.enablePan = false;
    this.controls.enabled = interactive;
    // Dragging only turns the model round.
    this.controls.minPolarAngle = this.controls.maxPolarAngle = POLAR;
    this.fit(width / height);

    this.wrapper.rotation.y = 0.5;
    this.wrapper.add(this.model);
    this.scene.add(this.wrapper);
    if (interactive) {
      this.scene.add(floatingIsland(), floorShadow());
      this.scene.add(new THREE.AmbientLight(0xffffff, 1.1));
      const sun = new THREE.DirectionalLight(0xffffff, 1.4);
      sun.position.set(30, 60, 40);
      this.scene.add(sun);
    }

    this.loop();
  }

  resize(width: number, height: number) {
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.fit(width / height);
  }

  /** Puts the camera as far back as the model needs to fit the view whatever its shape, keeping the angle it is turned to. */
  private fit(aspect: number) {
    const visibleHeight = Math.max(this.fitting.height, this.fitting.width / aspect);
    const distance = visibleHeight / (2 * Math.tan((FOV * DEG) / 2));
    const theta = this.controls.getAzimuthalAngle();
    const target = this.controls.target;
    this.camera.position.set(
      target.x + distance * Math.sin(POLAR) * Math.sin(theta),
      target.y + distance * Math.cos(POLAR),
      target.z + distance * Math.sin(POLAR) * Math.cos(theta),
    );
    this.controls.update();
  }

  /** (Re)builds the bones from a `.geo.json`; `slim` narrows the arms. */
  setModel(geometry: any, slim: boolean) {
    this.model.clear();
    this.bones.clear();
    const { bones, texture } = parseBones(geometry, slim);
    const pivots = new Map(bones.map((b) => [b.name, b.pivot]));
    for (const def of bones) {
      const group = new THREE.Group();
      group.rotation.order = "ZYX";
      const parentPivot = (def.parent && pivots.get(def.parent)) || [0, 0, 0];
      const rest = def.pivot.map((v, i) => v - parentPivot[i]) as Vec;
      const mesh = buildMesh(def, texture, this.material);
      if (mesh) group.add(mesh);
      this.bones.set(def.name, { group, rest, rotation: def.rotation });
    }
    for (const def of bones) {
      const parent = def.parent ? this.bones.get(def.parent)?.group : undefined;
      (parent ?? this.model).add(this.bones.get(def.name)!.group);
    }
    this.pose(this.clip ? poseAt(this.clip, this.progress) : new Map());
  }

  setSkin(uri: string | null) {
    this.material.map?.dispose();
    this.material.map = null;
    this.material.needsUpdate = true;
    if (!uri) return;
    new THREE.TextureLoader().load(uri, (texture) => {
      texture.magFilter = THREE.NearestFilter;
      texture.minFilter = THREE.NearestFilter;
      texture.colorSpace = THREE.SRGBColorSpace;
      this.material.map = texture;
      this.material.needsUpdate = true;
    });
  }

  /** Starts `clip` from its first frame, playing or (not `playing`) held on that frame; `null` puts the model at rest. */
  setClip(clip: Clip | null, playing = true) {
    this.clip = clip;
    this.playing = playing;
    this.progress = 0;
    this.pose(clip ? poseAt(clip, 0) : new Map());
  }

  private pose(poses: Map<string, Pose>) {
    for (const [name, bone] of this.bones) {
      const pose = poses.get(name);
      const r = pose?.rotation ?? [0, 0, 0];
      bone.group.rotation.set(
        (bone.rotation[0] + r[0]) * ROT_SIGN[0] * DEG,
        (bone.rotation[1] + r[1]) * ROT_SIGN[1] * DEG,
        (bone.rotation[2] + r[2]) * ROT_SIGN[2] * DEG,
      );
      const p = pose?.position ?? [0, 0, 0];
      bone.group.position.set(bone.rest[0] + p[0] * POS_SIGN[0], bone.rest[1] + p[1] * POS_SIGN[1], bone.rest[2] + p[2] * POS_SIGN[2]);
      const s = pose?.scale ?? [1, 1, 1];
      bone.group.scale.set(s[0], s[1], s[2]);
    }
  }

  private loop = () => {
    this.frame = requestAnimationFrame(this.loop);
    const now = performance.now();
    if (this.clip && this.playing) {
      this.progress += (now - this.last) / 1000;
      this.pose(poseAt(this.clip, this.progress));
    }
    this.last = now;
    this.renderer.render(this.scene, this.camera);
  };

  dispose() {
    cancelAnimationFrame(this.frame);
    this.controls.dispose();
    this.material.map?.dispose();
    this.material.dispose();
    this.model.traverse((o) => { if (o instanceof THREE.Mesh) o.geometry.dispose(); });
    this.renderer.dispose();
  }
}
