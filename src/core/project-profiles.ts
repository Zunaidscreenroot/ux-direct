import type { ProjectLifecycle, ProjectProfileId, UXHandId } from "./hand-contracts";

export type FoundationStep =
  | "requirements-intake"
  | "benchmark-research"
  | "journey-architecture"
  | "wireframe-kit-generation"
  | "human-approval"
  | "cockpit-execution"
  | "independent-ux-audit"
  | "quality-handoff";

export interface UXProjectProfile {
  id: ProjectProfileId;
  clientId: "dmi" | "ujjivan";
  displayName: string;
  lifecycle: ProjectLifecycle;
  primaryHand: "cockpit";
  defaultHands: readonly UXHandId[];
  specialistHands: readonly UXHandId[];
  initialFoundation: {
    required: boolean;
    sequence: readonly FoundationStep[];
    hands: readonly UXHandId[];
    completionArtifact?: string;
  };
  knowledge: {
    clientNamespace: string;
    projectNamespace: string;
    allowCrossProjectMemory: false;
    sharedKnowledgePack: "bfci-generic";
  };
}

/**
 * DMI stays brownfield and Cockpit-first. The specialist modules are available,
 * but they are never forced into a normal DMI task.
 */
const DMI_PROFILES: readonly UXProjectProfile[] = [
  {
    id: "dmi-hfc",
    clientId: "dmi",
    displayName: "DMI Housing Finance",
    lifecycle: "brownfield",
    primaryHand: "cockpit",
    defaultHands: ["cockpit"],
    specialistHands: ["wireframe-foundry", "ux-auditor", "benchmark-lab", "journey-architect", "quality-handoff"],
    initialFoundation: { required: false, sequence: [], hands: [] },
    knowledge: {
      clientNamespace: "client:dmi",
      projectNamespace: "project:dmi-hfc",
      allowCrossProjectMemory: false,
      sharedKnowledgePack: "bfci-generic",
    },
  },
  {
    id: "dmi-finance",
    clientId: "dmi",
    displayName: "DMI Finance",
    lifecycle: "brownfield",
    primaryHand: "cockpit",
    defaultHands: ["cockpit"],
    specialistHands: ["wireframe-foundry", "ux-auditor", "benchmark-lab", "journey-architect", "quality-handoff"],
    initialFoundation: { required: false, sequence: [], hands: [] },
    knowledge: {
      clientNamespace: "client:dmi",
      projectNamespace: "project:dmi-finance",
      allowCrossProjectMemory: false,
      sharedKnowledgePack: "bfci-generic",
    },
  },
  {
    id: "dmi-wealth",
    clientId: "dmi",
    displayName: "DMI Wealth",
    lifecycle: "brownfield",
    primaryHand: "cockpit",
    defaultHands: ["cockpit"],
    specialistHands: ["wireframe-foundry", "ux-auditor", "benchmark-lab", "journey-architect", "quality-handoff"],
    initialFoundation: { required: false, sequence: [], hands: [] },
    knowledge: {
      clientNamespace: "client:dmi",
      projectNamespace: "project:dmi-wealth",
      allowCrossProjectMemory: false,
      sharedKnowledgePack: "bfci-generic",
    },
  },
] as const;

const UJJIVAN_PROFILE: UXProjectProfile = {
  id: "ujjivan-sfb",
  clientId: "ujjivan",
  displayName: "Ujjivan Small Finance Bank",
  lifecycle: "greenfield",
  primaryHand: "cockpit",
  // Cockpit becomes the default daily hand from day one. The initial
  // foundation hands run only when the foundation has not yet been approved.
  defaultHands: ["cockpit"],
  specialistHands: ["wireframe-foundry", "ux-auditor", "benchmark-lab", "journey-architect", "quality-handoff"],
  initialFoundation: {
    required: true,
    sequence: [
      "requirements-intake",
      "benchmark-research",
      "journey-architecture",
      "wireframe-kit-generation",
      "human-approval",
      "cockpit-execution",
      "independent-ux-audit",
      "quality-handoff",
    ],
    hands: [
      "benchmark-lab",
      "journey-architect",
      "wireframe-foundry",
      "ux-auditor",
      "quality-handoff",
    ],
    completionArtifact: "approved-wireframe-kit-manifest",
  },
  knowledge: {
    clientNamespace: "client:ujjivan",
    projectNamespace: "project:ujjivan-sfb",
    allowCrossProjectMemory: false,
    sharedKnowledgePack: "bfci-generic",
  },
};

export const UX_PROJECT_PROFILES: readonly UXProjectProfile[] = [
  ...DMI_PROFILES,
  UJJIVAN_PROFILE,
];

export function getProjectProfile(id: ProjectProfileId): UXProjectProfile {
  const profile = UX_PROJECT_PROFILES.find((candidate) => candidate.id === id);
  if (!profile) throw new Error(`Unknown UX project profile: ${id}`);
  return profile;
}

/**
 * Only an uninitialised greenfield project enters its foundation workflow.
 * A brownfield project such as DMI remains Cockpit-first even if specialists
 * are available. Existing approved kits can be supplied through kitVersion.
 */
export function shouldRunInitialFoundation(input: {
  projectId: ProjectProfileId;
  approvedKitVersion?: string;
  foundationMarkedComplete?: boolean;
}): boolean {
  const profile = getProjectProfile(input.projectId);
  if (!profile.initialFoundation.required) return false;
  if (input.foundationMarkedComplete) return false;
  if (input.approvedKitVersion?.trim()) return false;
  return true;
}

/** Default hands do not change after foundation completion: Cockpit stays primary. */
export function getDefaultHands(projectId: ProjectProfileId): readonly UXHandId[] {
  return getProjectProfile(projectId).defaultHands;
}
