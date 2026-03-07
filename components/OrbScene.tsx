"use client";

import {
  Component,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import { Canvas, type ThreeEvent, useFrame } from "@react-three/fiber";
import { ContactShadows, useGLTF } from "@react-three/drei";
import { useRouter } from "next/navigation";
import { Bloom, EffectComposer, Noise, Vignette } from "@react-three/postprocessing";
import {
  BackSide,
  Box3,
  Color,
  Group,
  Material,
  MathUtils,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Points,
  Vector3
} from "three";
import styles from "./orb-scene.module.css";

type OrbSceneProps = {
  reducedMotion?: boolean;
  zoomRequestId?: number;
  demoMode?: boolean;
  onTransitionChange?: (isTransitioning: boolean) => void;
};

const MODEL_PATH = "/models/neuronal_cell_environment.glb";
const RECORD_ROUTE = "/record?mode=breathing";
const BASE_BLOOM_INTENSITY = 0.84;
const TRANSITION_BLOOM_INTENSITY = 1.16;
const HOVER_TINT = new Color("#7ed7ff");
const CLICK_TINT = new Color("#c1efff");

type PortalTransitionState = {
  active: boolean;
  pendingTarget: Vector3 | null;
  startTime: number;
  duration: number;
  fromPosition: Vector3;
  fromLookAt: Vector3;
  toPosition: Vector3;
  toLookAt: Vector3;
};

type ModelErrorBoundaryProps = {
  children: ReactNode;
  onError: (error: Error) => void;
};

type ModelErrorBoundaryState = {
  hasError: boolean;
};

class ModelErrorBoundary extends Component<ModelErrorBoundaryProps, ModelErrorBoundaryState> {
  state: ModelErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error) {
    this.props.onError(error);
  }

  render() {
    if (this.state.hasError) return null;
    return this.props.children;
  }
}

function webglAvailable() {
  if (typeof window === "undefined") return true;
  const canvas = document.createElement("canvas");
  return !!(canvas.getContext("webgl2") || canvas.getContext("webgl"));
}

function easeInOutCubic(t: number) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function isStandardMaterial(material: Material): material is MeshStandardMaterial {
  return (material as MeshStandardMaterial).isMeshStandardMaterial === true;
}

function tuneMaterial(material: Material) {
  const tuned = material.clone();
  if (isStandardMaterial(tuned)) {
    if (tuned.emissiveIntensity > 0) {
      tuned.emissiveIntensity = Math.min(tuned.emissiveIntensity * 1.14 + 0.02, 2.3);
    }
    tuned.metalness = Math.min((tuned.metalness ?? 0) + 0.05, 1);
    tuned.roughness = MathUtils.clamp((tuned.roughness ?? 1) * 0.93, 0.06, 1);
  }
  return tuned;
}

function findInteractiveMesh(object: Object3D | null) {
  let current: Object3D | null = object;
  while (current) {
    const candidate = current as Mesh;
    if (candidate.isMesh) return candidate;
    current = current.parent;
  }
  return null;
}

function CameraRig({
  reducedMotion,
  portalRef,
  setBloomIntensity,
  onPortalComplete
}: {
  reducedMotion: boolean;
  portalRef: React.MutableRefObject<PortalTransitionState>;
  setBloomIntensity: React.Dispatch<React.SetStateAction<number>>;
  onPortalComplete: () => void;
}) {
  const idleTarget = useRef(new Vector3(0, 0, 0));
  const desiredPosition = useRef(new Vector3(0, 0.06, 3.7));
  const lookTarget = useRef(new Vector3(0, 0, 0));
  const bloomCache = useRef(BASE_BLOOM_INTENSITY);

  const updateBloom = useCallback(
    (nextValue: number) => {
      if (Math.abs(nextValue - bloomCache.current) < 0.006) return;
      bloomCache.current = nextValue;
      setBloomIntensity(nextValue);
    },
    [setBloomIntensity]
  );

  useFrame((state, delta) => {
    const portal = portalRef.current;

    if (portal.pendingTarget && !portal.active) {
      const lookAtPoint = portal.pendingTarget.clone();
      const direction = state.camera.position.clone().sub(lookAtPoint).normalize();
      const diveDistance = 0.78;
      const destination = lookAtPoint.clone().add(direction.multiplyScalar(diveDistance));
      destination.y += 0.03;

      portal.active = true;
      portal.startTime = state.clock.getElapsedTime();
      portal.duration = reducedMotion ? 0.001 : 0.78;
      portal.fromPosition.copy(state.camera.position);
      portal.fromLookAt.copy(lookTarget.current);
      portal.toLookAt.copy(lookAtPoint);
      portal.toPosition.copy(destination);
      portal.pendingTarget = null;
    }

    if (portal.active) {
      const elapsed = state.clock.getElapsedTime() - portal.startTime;
      const progress = Math.min(elapsed / portal.duration, 1);
      const eased = easeInOutCubic(progress);

      state.camera.position.lerpVectors(portal.fromPosition, portal.toPosition, eased);
      lookTarget.current.lerpVectors(portal.fromLookAt, portal.toLookAt, eased);
      state.camera.lookAt(lookTarget.current);
      updateBloom(MathUtils.lerp(BASE_BLOOM_INTENSITY, TRANSITION_BLOOM_INTENSITY, eased));

      if (progress >= 1) {
        portal.active = false;
        onPortalComplete();
      }
      return;
    }

    const pointerX = reducedMotion ? 0 : state.pointer.x * 0.24;
    const pointerY = reducedMotion ? 0.05 : state.pointer.y * 0.14;
    desiredPosition.current.set(pointerX, pointerY, 3.7);
    idleTarget.current.set(pointerX * 0.14, pointerY * 0.09, 0);

    const lerpAlpha = 1 - Math.pow(0.001, delta);
    state.camera.position.lerp(desiredPosition.current, lerpAlpha);
    lookTarget.current.lerp(idleTarget.current, lerpAlpha * 0.75);
    state.camera.lookAt(lookTarget.current);
    updateBloom(BASE_BLOOM_INTENSITY);
  });

  return null;
}

function Atmosphere({ reducedMotion }: { reducedMotion: boolean }) {
  const hazeRef = useRef<Group>(null);
  const dustRef = useRef<Points>(null);

  const dustPositions = useMemo(() => {
    const count = 220;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) {
      const i3 = i * 3;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const radius = MathUtils.randFloat(2.5, 5.6);
      positions[i3] = radius * Math.sin(phi) * Math.cos(theta);
      positions[i3 + 1] = radius * Math.cos(phi) * 0.52;
      positions[i3 + 2] = radius * Math.sin(phi) * Math.sin(theta);
    }
    return positions;
  }, []);

  useFrame((state, delta) => {
    const t = state.clock.elapsedTime;

    if (hazeRef.current) {
      hazeRef.current.rotation.y += delta * 0.015;
      hazeRef.current.rotation.x = Math.sin(t * 0.08) * 0.09;
    }

    if (dustRef.current) {
      dustRef.current.rotation.y += delta * (reducedMotion ? 0.002 : 0.01);
      dustRef.current.rotation.x = Math.sin(t * 0.12) * 0.02;
    }
  });

  return (
    <>
      <group ref={hazeRef}>
        <mesh scale={[7.4, 7.4, 7.4]}>
          <sphereGeometry args={[1, 26, 26]} />
          <meshBasicMaterial color="#13304f" opacity={0.12} transparent side={BackSide} />
        </mesh>
      </group>

      <points ref={dustRef}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[dustPositions, 3]} />
        </bufferGeometry>
        <pointsMaterial color="#a6ebff" size={0.017} transparent opacity={0.18} depthWrite={false} />
      </points>
    </>
  );
}

type MaterialBaseState = {
  emissiveIntensity: number;
  emissiveColor: Color;
};

function HeroModel({
  reducedMotion,
  onPartClick
}: {
  reducedMotion: boolean;
  onPartClick: (point: Vector3) => void;
}) {
  const rootRef = useRef<Group>(null);
  const { scene } = useGLTF(MODEL_PATH);
  const hoveredMeshRef = useRef<Mesh | null>(null);
  const pulsingMeshRef = useRef<Mesh | null>(null);
  const pulseStartRef = useRef(0);
  const materialBaseRef = useRef(new WeakMap<MeshStandardMaterial, MaterialBaseState>());
  const pulseDuration = 0.42;

  const forEachStandardMaterial = useCallback(
    (mesh: Mesh, callback: (material: MeshStandardMaterial) => void) => {
      if (Array.isArray(mesh.material)) {
        mesh.material.forEach((material) => {
          if (!isStandardMaterial(material)) return;
          callback(material);
        });
        return;
      }

      if (mesh.material && isStandardMaterial(mesh.material)) {
        callback(mesh.material);
      }
    },
    []
  );

  const setMeshGlow = useCallback(
    (mesh: Mesh, emissiveBoost: number, tintColor: Color | null) => {
      forEachStandardMaterial(mesh, (material) => {
        const base = materialBaseRef.current.get(material);
        if (!base) return;
        material.emissiveIntensity = base.emissiveIntensity + emissiveBoost;
        material.emissive.copy(base.emissiveColor);
        if (tintColor) {
          material.emissive.lerp(tintColor, 0.32);
        }
      });
    },
    [forEachStandardMaterial]
  );

  const resetMeshGlow = useCallback(
    (mesh: Mesh) => {
      setMeshGlow(mesh, 0, null);
    },
    [setMeshGlow]
  );

  const setHoveredMesh = useCallback(
    (nextMesh: Mesh | null) => {
      if (hoveredMeshRef.current === nextMesh) return;

      if (hoveredMeshRef.current && hoveredMeshRef.current !== pulsingMeshRef.current) {
        resetMeshGlow(hoveredMeshRef.current);
      }

      hoveredMeshRef.current = nextMesh;
      if (hoveredMeshRef.current) {
        setMeshGlow(hoveredMeshRef.current, 0.16, HOVER_TINT);
      }
    },
    [resetMeshGlow, setMeshGlow]
  );

  const model = useMemo(() => {
    const clone = scene.clone(true);
    clone.traverse((object) => {
      const candidate = object as Mesh;
      if (!candidate.isMesh) return;
      candidate.castShadow = true;
      candidate.receiveShadow = true;

      if (Array.isArray(candidate.material)) {
        candidate.material = candidate.material.map((material) => {
          const tuned = tuneMaterial(material);
          if (isStandardMaterial(tuned)) {
            materialBaseRef.current.set(tuned, {
              emissiveIntensity: tuned.emissiveIntensity,
              emissiveColor: tuned.emissive.clone()
            });
          }
          return tuned;
        });
      } else if (candidate.material) {
        const tuned = tuneMaterial(candidate.material);
        if (isStandardMaterial(tuned)) {
          materialBaseRef.current.set(tuned, {
            emissiveIntensity: tuned.emissiveIntensity,
            emissiveColor: tuned.emissive.clone()
          });
        }
        candidate.material = tuned;
      }
    });
    return clone;
  }, [scene]);

  const fit = useMemo(() => {
    const bounds = new Box3().setFromObject(model);
    const size = new Vector3();
    const center = new Vector3();
    bounds.getSize(size);
    bounds.getCenter(center);
    const maxAxis = Math.max(size.x, size.y, size.z) || 1;
    const scale = 4.6 / maxAxis;
    return {
      scale,
      offset: [-center.x * scale, -center.y * scale, -center.z * scale] as [number, number, number]
    };
  }, [model]);

  useEffect(() => {
    return () => {
      document.body.style.cursor = "default";
    };
  }, []);

  useFrame((state, delta) => {
    if (!rootRef.current) return;

    const t = state.clock.elapsedTime;
    const breath = reducedMotion ? 1 : 1 + Math.sin(t * 1.3) * 0.02;
    rootRef.current.scale.setScalar(breath);
    rootRef.current.rotation.y += delta * 0.1 * (reducedMotion ? 0.25 : 1);
    rootRef.current.rotation.x = Math.sin(t * 0.25) * (reducedMotion ? 0.012 : 0.035);
    rootRef.current.position.y = reducedMotion ? -0.22 : -0.22 + Math.sin(t * 0.52) * 0.03;

    if (pulsingMeshRef.current) {
      const elapsed = performance.now() / 1000 - pulseStartRef.current;
      const progress = Math.min(elapsed / pulseDuration, 1);
      const wave = Math.sin(progress * Math.PI);
      setMeshGlow(pulsingMeshRef.current, 0.2 + wave * 0.56, CLICK_TINT);

      if (progress >= 1) {
        const shouldKeepHover = hoveredMeshRef.current === pulsingMeshRef.current;
        if (shouldKeepHover && hoveredMeshRef.current) {
          setMeshGlow(hoveredMeshRef.current, 0.16, HOVER_TINT);
        } else if (pulsingMeshRef.current) {
          resetMeshGlow(pulsingMeshRef.current);
        }
        pulsingMeshRef.current = null;
      }
    }
  });

  const handlePointerMove = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    const mesh = findInteractiveMesh(event.object);
    if (!mesh) return;
    document.body.style.cursor = "pointer";
    setHoveredMesh(mesh);
  };

  const handlePointerOut = (event: ThreeEvent<PointerEvent>) => {
    event.stopPropagation();
    document.body.style.cursor = "default";
    setHoveredMesh(null);
  };

  const handleClick = (event: ThreeEvent<MouseEvent>) => {
    event.stopPropagation();
    const mesh = findInteractiveMesh(event.object);
    if (!mesh) return;

    pulsingMeshRef.current = mesh;
    pulseStartRef.current = performance.now() / 1000;
    setMeshGlow(mesh, 0.34, CLICK_TINT);
    onPartClick(event.point.clone());
  };

  return (
    <group ref={rootRef}>
      <primitive
        object={model}
        position={fit.offset}
        scale={fit.scale}
        onPointerMove={handlePointerMove}
        onPointerOut={handlePointerOut}
        onClick={handleClick}
      />
    </group>
  );
}

export default function OrbScene({
  reducedMotion = false,
  zoomRequestId = 0,
  demoMode = false,
  onTransitionChange
}: OrbSceneProps) {
  const [supportsWebGL, setSupportsWebGL] = useState(true);
  const [modelError, setModelError] = useState<Error | null>(null);
  const [bloomIntensity, setBloomIntensity] = useState(BASE_BLOOM_INTENSITY);
  const router = useRouter();
  const portalRef = useRef<PortalTransitionState>({
    active: false,
    pendingTarget: null,
    startTime: 0,
    duration: 0.78,
    fromPosition: new Vector3(),
    fromLookAt: new Vector3(),
    toPosition: new Vector3(),
    toLookAt: new Vector3()
  });
  const zoomRequestSeenRef = useRef(zoomRequestId);
  const navigatingRef = useRef(false);

  useEffect(() => {
    setSupportsWebGL(webglAvailable());
  }, []);

  const handlePortalComplete = useCallback(() => {
    if (demoMode) {
      onTransitionChange?.(false);
      return;
    }
    if (navigatingRef.current) return;
    navigatingRef.current = true;
    router.push(RECORD_ROUTE);
  }, [demoMode, onTransitionChange, router]);

  const beginPortal = useCallback(
    (targetPoint?: Vector3) => {
      if (navigatingRef.current || modelError || demoMode) return;

      if (reducedMotion) {
        navigatingRef.current = true;
        router.push(RECORD_ROUTE);
        return;
      }

      const portal = portalRef.current;
      if (portal.active || portal.pendingTarget) return;

      onTransitionChange?.(true);
      portal.pendingTarget = targetPoint ? targetPoint.clone() : new Vector3(0, -0.05, 0);
    },
    [demoMode, modelError, onTransitionChange, reducedMotion, router]
  );

  useEffect(() => {
    if (zoomRequestId === zoomRequestSeenRef.current) return;
    zoomRequestSeenRef.current = zoomRequestId;
    beginPortal();
  }, [beginPortal, zoomRequestId]);

  if (modelError) {
    return (
      <div className={styles.errorWrap} role="status" aria-live="polite">
        <p className={styles.errorTitle}>Model failed to load</p>
        <p className={styles.errorPath}>{MODEL_PATH}</p>
      </div>
    );
  }

  if (!supportsWebGL) {
    return <div className={styles.fallback} aria-hidden />;
  }

  return (
    <div className={styles.canvasWrap} aria-hidden>
      <Canvas
        shadows
        dpr={[1, 1.75]}
        camera={{ position: [0, 0.06, 3.7], fov: 27 }}
        gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
      >
        <color attach="background" args={["#02050c"]} />
        <fog attach="fog" args={["#081828", 2.8, 8.4]} />

        <ambientLight intensity={0.2} color="#8fb2df" />
        <hemisphereLight intensity={0.36} color="#d7f0ff" groundColor="#04101f" />
        <directionalLight
          castShadow
          position={[2.2, 2.7, 2.4]}
          intensity={2.15}
          color="#edf7ff"
          shadow-mapSize-width={1024}
          shadow-mapSize-height={1024}
          shadow-camera-far={10}
          shadow-camera-near={0.5}
          shadow-normalBias={0.02}
        />
        <pointLight position={[-2.8, 1.15, -3.9]} intensity={24} color="#6fd6ff" distance={12} />
        <pointLight position={[0, 0.25, -6.2]} intensity={36} color="#44b8ff" distance={18} />
        <spotLight
          position={[1.2, 2.1, -2.9]}
          intensity={18}
          color="#95e3ff"
          angle={0.5}
          penumbra={1}
        />

        <Atmosphere reducedMotion={reducedMotion} />
        <ContactShadows
          position={[0, -1.42, 0]}
          scale={8.5}
          blur={2.6}
          opacity={0.38}
          far={4}
          resolution={512}
          color="#0b3551"
        />
        <ModelErrorBoundary onError={setModelError}>
          <Suspense fallback={null}>
            <HeroModel reducedMotion={reducedMotion} onPartClick={beginPortal} />
          </Suspense>
        </ModelErrorBoundary>
        <CameraRig
          reducedMotion={reducedMotion}
          portalRef={portalRef}
          setBloomIntensity={setBloomIntensity}
          onPortalComplete={handlePortalComplete}
        />

        <EffectComposer multisampling={0}>
          <Bloom
            intensity={bloomIntensity}
            mipmapBlur
            luminanceThreshold={0.18}
            luminanceSmoothing={0.91}
          />
          <Vignette eskil={false} offset={0.18} darkness={0.78} />
          <Noise opacity={0.022} premultiply />
        </EffectComposer>
      </Canvas>
    </div>
  );
}

useGLTF.preload(MODEL_PATH);
