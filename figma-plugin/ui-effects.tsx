import { createRoot, type Root } from "react-dom/client";
import { BorderBeam } from "border-beam";
import { ThinkingOrb } from "thinking-orbs";
import type { CSSProperties } from "react";

type ProcessState =
  | "idle" | "scanning" | "capturing" | "brain" | "memory" | "planning"
  | "waiting" | "creating" | "rendering" | "reviewing" | "refining"
  | "verifying" | "done" | "error";

type OrbState = "working" | "searching" | "solving" | "listening" | "connecting" | "weaving" | "composing" | "breathing" | "shaping";
type EffectApi = {
  setProcessState: (state: string) => void;
  setBeamEmphasis: (active: boolean) => void;
};

declare global {
  interface Window {
    UXDEffects?: EffectApi;
  }
}

const PROCESS_TO_ORB: Record<ProcessState, OrbState> = {
  idle: "listening",
  scanning: "searching",
  capturing: "searching",
  brain: "connecting",
  memory: "searching",
  planning: "solving",
  waiting: "connecting",
  creating: "composing",
  rendering: "working",
  reviewing: "solving",
  refining: "weaving",
  verifying: "solving",
  done: "breathing",
  error: "solving",
};

const ORB_LABEL: Record<OrbState, string> = {
  working: "Creating the design",
  searching: "Searching selected layers and memories",
  solving: "Reasoning about the design",
  listening: "Ready for a design request",
  connecting: "Connecting to UX Direct services",
  weaving: "Refining the design",
  composing: "Creating editable Figma layers",
  breathing: "Task complete",
  shaping: "Shaping the design",
};

const ORB_ROOT_STYLE: CSSProperties = {
  display: "grid",
  placeItems: "center",
  width: "100%",
  height: "100%",
  overflow: "visible",
};

function AgentOrb({ state, size, paused = false }: { state: OrbState; size: 20 | 64; paused?: boolean }) {
  return (
    <ThinkingOrb
      state={state}
      size={size}
      theme="dark"
      paused={paused}
      aria-label={ORB_LABEL[state]}
      style={{ display: "block" }}
    />
  );
}

function BeamOverlay({ emphasis }: { emphasis: boolean }) {
  const wrapperStyle: CSSProperties = {
    position: "absolute",
    inset: 0,
    display: "block",
    width: "100%",
    height: "100%",
    zIndex: 0,
    pointerEvents: "none",
  };
  const beamChildStyle: CSSProperties = {
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    border: "1px solid transparent",
    borderRadius: 15,
    background: "transparent",
    pointerEvents: "none",
  };

  return (
    <BorderBeam
      size="md"
      colorVariant="ocean"
      theme="dark"
      strength={0.86}
      duration={2.8}
      borderRadius={15}
      staticColors
      active={emphasis}
      className="uxd-composer-border-beam"
      style={wrapperStyle}
      aria-hidden="true"
    >
      <div aria-hidden="true" style={beamChildStyle} />
    </BorderBeam>
  );
}

const heroContainer = document.getElementById("uxdOrbRoot");
const statusContainer = document.getElementById("processOrbRoot");
const beamContainer = document.getElementById("beamRoot");

let processState: ProcessState = "idle";
let beamEmphasis = false;
let heroRoot: Root | null = null;
let statusRoot: Root | null = null;
let beamRoot: Root | null = null;

function renderOrbs() {
  const orbState = PROCESS_TO_ORB[processState];
  const paused = processState === "error";
  heroRoot?.render(
    <div style={ORB_ROOT_STYLE}>
      <AgentOrb state={orbState} size={processState === "idle" ? 64 : 20} paused={paused} />
    </div>,
  );
  statusRoot?.render(
    <div style={ORB_ROOT_STYLE}>
      <AgentOrb state={orbState} size={20} paused={paused} />
    </div>,
  );
}

function renderBeam() {
  beamRoot?.render(<BeamOverlay emphasis={beamEmphasis} />);
}

if (heroContainer) heroRoot = createRoot(heroContainer);
if (statusContainer) statusRoot = createRoot(statusContainer);
if (beamContainer) beamRoot = createRoot(beamContainer);

renderOrbs();
renderBeam();

window.UXDEffects = {
  setProcessState(state) {
    processState = state in PROCESS_TO_ORB ? state as ProcessState : "planning";
    renderOrbs();
  },
  setBeamEmphasis(active) {
    const next = Boolean(active);
    if (next === beamEmphasis) return;
    beamEmphasis = next;
    renderBeam();
  },
};
