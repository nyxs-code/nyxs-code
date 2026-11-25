import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { getLanguage, useTranslations } from "@/lib/i18n";
import { base64ToBytes, gltfNeedsOtherFiles, modelInfo, type ModelFormat } from "@/lib/model3d";

/** For formats without materials. Both sides: exported meshes often have faces turned inside out. */
const plainMaterial = () => new THREE.MeshStandardMaterial({ color: 0xb8bcc8, metalness: 0.1, roughness: 0.6, side: THREE.DoubleSide });

/** Parses the model into one object to show; throws with what went wrong. */
async function parseModel(format: ModelFormat, bytes: Uint8Array): Promise<THREE.Object3D> {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  if (format === "stl") {
    const geometry = new STLLoader().parse(buffer);
    geometry.computeVertexNormals();
    return new THREE.Mesh(geometry, plainMaterial());
  }
  if (format === "obj") {
    const obj = new OBJLoader().parse(new TextDecoder().decode(bytes));
    obj.traverse((o) => {
      if (o instanceof THREE.Mesh) o.material = plainMaterial();
    });
    return obj;
  }
  const gltf = await new GLTFLoader().parseAsync(format === "gltf" ? new TextDecoder().decode(bytes) : buffer, "");
  return gltf.scene;
}

function countTriangles(root: THREE.Object3D): number {
  let n = 0;
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const g = o.geometry as THREE.BufferGeometry;
    n += (g.index ? g.index.count : (g.attributes.position?.count ?? 0)) / 3;
  });
  return n;
}

/** The Files panel's 3D view (like Claude's): a glb, gltf, stl or obj on a turntable. Drag to
 *  rotate, scroll to zoom; the arrow keys rotate and Shift with an arrow moves it. */
export default function ModelView({ base64, format, name }: { base64: string; format: ModelFormat; name: string }) {
  const t = useTranslations().views;
  const host = useRef<HTMLDivElement>(null);
  const [info, setInfo] = useState("");
  const [failed, setFailed] = useState("");
  const bytes = useMemo(() => base64ToBytes(base64), [base64]);
  const needsOtherFiles = useMemo(() => format === "gltf" && gltfNeedsOtherFiles(new TextDecoder().decode(bytes)), [format, bytes]);
  const error = needsOtherFiles ? t.modelOtherFiles : failed;

  useEffect(() => {
    const el = host.current;
    if (!el || needsOtherFiles) return;
    let disposed = false;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 2);
    sun.position.set(3, 5, 4);
    scene.add(sun);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.listenToKeyEvents(el);
    controls.keyRotateSpeed = 1.5;

    const resize = () => {
      const w = el.clientWidth || 1;
      const h = el.clientHeight || 1;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();

    let frame = 0;
    const loop = () => {
      controls.update();
      renderer.render(scene, camera);
      frame = requestAnimationFrame(loop);
    };

    parseModel(format, bytes)
      .then((model) => {
        if (disposed) return;
        // Centered on the origin and framed whole, whatever its units.
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        model.position.sub(box.getCenter(new THREE.Vector3()));
        scene.add(model);
        const radius = Math.max(size.length() / 2, 1e-6);
        // Framed by the narrower of the two angles: the panel is often taller than wide.
        const vFov = (camera.fov * Math.PI) / 180;
        const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
        const distance = (radius / Math.sin(Math.min(vFov, hFov) / 2)) * 1.05;
        camera.near = distance / 100;
        camera.far = distance * 100;
        camera.position.set(distance * 0.6, distance * 0.45, distance * 0.65);
        camera.updateProjectionMatrix();
        controls.target.set(0, 0, 0);
        controls.update();
        setInfo(modelInfo(countTriangles(model), size, getLanguage(), t.modelInfo));
        loop();
      })
      .catch((e: unknown) => {
        if (!disposed) setFailed(t.modelUnreadable.replace("{error}", e instanceof Error ? e.message : String(e)));
      });

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      ro.disconnect();
      controls.dispose();
      scene.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          mats.forEach((m) => m.dispose());
        }
      });
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [bytes, format, needsOtherFiles, t]);

  return (
    <div className="flex h-full flex-col gap-2 p-4">
      {error ? (
        <p className="text-[12px] text-text-400">{error}</p>
      ) : (
        <>
          <div
            ref={host}
            tabIndex={0}
            role="img"
            aria-label={t.model3d.replace("{name}", name)}
            className="min-h-[240px] flex-1 cursor-grab overflow-hidden rounded-md border border-bg-300 bg-[radial-gradient(circle_at_50%_40%,rgba(127,127,127,0.12),transparent_70%)] outline-none focus-visible:ring-2 focus-visible:ring-accent active:cursor-grabbing"
          />
          <p className="text-[11.5px] text-text-500">
            {info && <span className="tabular-nums">{info} · </span>}
            {t.modelHint}
          </p>
        </>
      )}
    </div>
  );
}
