/**
 * The console view: what a person sees, derived from the ledger and nothing
 * else (ADR-0013's discipline, applied to presentation).
 *
 * This is a pure fold. It holds no state of its own, calls nothing, and cannot
 * write: given the same events it produces the same view, so the console can be
 * rebuilt by replaying history and a reader is never shown something the ledger
 * does not say.
 *
 * Two rules it keeps, because breaking either is how a dashboard starts lying:
 *
 *   1. **Nothing is invented.** Every headline is built from payload the event
 *      actually carries. Where the ledger says `the test run exited 1`, that is
 *      what a reader sees — not a generic "stage failed".
 *   2. **Nothing is silently dropped.** An event type this fold does not
 *      understand still appears, in the core's lane, under its real type, and
 *      is counted as an anomaly. A console that hid what it could not parse
 *      would be most misleading exactly when something unusual happened.
 */

import type { GenesisEvent } from '@genesis/core-types';
import { type Lane, laneOfRole, STAGE_LABELS, STAGE_LANES } from './lanes.js';

export const SEVERITIES = ['INFO', 'ACTIVE', 'SUCCESS', 'WARN', 'FAILURE'] as const;
export type Severity = (typeof SEVERITIES)[number];

export interface EventView {
  readonly seq: number;
  readonly id: string;
  readonly type: string;
  readonly timestamp: string;
  readonly actorKind: string;
  readonly authority: string;
  readonly lane: Lane;
  readonly stage: string | null;
  readonly pass: number | null;
  readonly headline: string;
  readonly detail: string | null;
  readonly severity: Severity;
  readonly runId: string | null;
  readonly taskId: string | null;
  readonly artifactId: string | null;
  /** True when this fold had no specific reading for the event type. */
  readonly unrecognised: boolean;
}

export interface StageView {
  readonly stage: string;
  readonly label: string;
  readonly pass: number;
  readonly lane: Lane;
  readonly enteredSeq: number;
  readonly settledSeq: number | null;
  readonly result: 'RUNNING' | 'PASSED' | 'FAILED' | 'SKIPPED';
  readonly detail: string | null;
  readonly taskId: string | null;
}

export interface ArtifactView {
  readonly artifactId: string;
  readonly path: string;
  readonly contentHash: string;
  readonly bytes: number;
  readonly language: string | null;
  readonly contents: string | null;
  readonly proposedBy: string | null;
  readonly proposedSeq: number;
  readonly state: string;
  readonly evidenceCount: number;
  readonly verifiedSeq: number | null;
}

export interface FindingView {
  readonly rule: string;
  readonly severity: string;
  readonly artifactId: string;
  readonly detail: string;
  readonly blocking: boolean;
  readonly seq: number;
}

export interface LaneView {
  readonly lane: Lane;
  readonly events: number;
  readonly lastSeq: number | null;
  readonly lastHeadline: string | null;
  readonly tasks: number;
  readonly failures: number;
}

export interface GoalView {
  readonly goalId: string;
  readonly description: string;
  readonly status: string;
  readonly priority: number;
}

export interface RunView {
  readonly runId: string;
  readonly goalId: string;
  readonly title: string;
  readonly maxRepairAttempts: number;
  readonly startedSeq: number;
  readonly outcome: string | null;
  readonly summary: string | null;
  readonly stagesRun: number | null;
  readonly repairAttempts: number | null;
  readonly highestState: string | null;
  readonly blockedReason: string | null;
}

export interface ConsoleState {
  readonly goals: readonly GoalView[];
  readonly run: RunView | null;
  readonly stages: readonly StageView[];
  readonly artifacts: readonly ArtifactView[];
  readonly findings: readonly FindingView[];
  readonly lanes: Readonly<Record<Lane, LaneView>>;
  readonly events: readonly EventView[];
  /** The lane that most recently did something. What the console highlights. */
  readonly activeLane: Lane | null;
  readonly lastSeq: number;
  /** Event types this fold had no reading for. Empty, or something is new. */
  readonly anomalies: readonly string[];
}

// --------------------------------------------------------------- internals

/** Mutable working state. Exposed only through the immutable view above. */
interface Working {
  goals: Map<string, GoalView>;
  run: RunView | null;
  stages: StageView[];
  artifacts: Map<string, ArtifactView>;
  findings: FindingView[];
  lanes: Map<Lane, LaneView>;
  events: EventView[];
  activeLane: Lane | null;
  lastSeq: number;
  anomalies: Set<string>;
  /** taskId → the role it was assigned to. The only way later task events are attributed. */
  taskRoles: Map<string, string>;
  /** callId → taskId, so a reasoning response reaches the agent that asked. */
  callTasks: Map<string, string>;
  /** The stage the run is in, for events that belong to it but do not name it. */
  currentStage: string | null;
  currentPass: number | null;
}

const obj = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const str = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);
const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** A short, readable form of a long identifier. Full ids stay in the payload. */
export const shortId = (id: string): string => {
  const body = id.includes('_') ? (id.split('_')[1] as string) : id;
  return body.length <= 8 ? body : `${body.slice(0, 4)}…${body.slice(-4)}`;
};

const blankLane = (lane: Lane): LaneView => ({
  lane,
  events: 0,
  lastSeq: null,
  lastHeadline: null,
  tasks: 0,
  failures: 0,
});

export function emptyConsole(): ConsoleState {
  return foldConsole([]);
}

/** A fresh working state. */
const start = (): Working => ({
  goals: new Map(),
  run: null,
  stages: [],
  artifacts: new Map(),
  findings: [],
  lanes: new Map(),
  events: [],
  activeLane: null,
  lastSeq: 0,
  anomalies: new Set(),
  taskRoles: new Map(),
  callTasks: new Map(),
  currentStage: null,
  currentPass: null,
});

/** What one event says. The whole reading of the ledger is here. */
interface Reading {
  readonly lane?: Lane;
  readonly headline: string;
  readonly detail?: string | null;
  readonly severity?: Severity;
  readonly stage?: string | null;
  readonly pass?: number | null;
  readonly runId?: string | null;
  readonly taskId?: string | null;
  readonly artifactId?: string | null;
  readonly unrecognised?: boolean;
}

/**
 * The lane an agent-task event belongs to.
 *
 * Looked up from what `AGENT_TASK_ASSIGNED` said, because no later event on the
 * task repeats the role. If the assignment was never seen — a stream joined
 * late — the stage's owner is the honest fallback, and the core's lane is the
 * honest answer when there is no stage either.
 */
const laneOfTask = (w: Working, taskId: string | null): Lane => {
  const role = taskId === null ? undefined : w.taskRoles.get(taskId);
  if (role !== undefined) return laneOfRole(role);
  if (w.currentStage !== null) return STAGE_LANES[w.currentStage as keyof typeof STAGE_LANES] ?? 'SYSTEM';
  return 'SYSTEM';
};

// eslint-disable-next-line complexity -- one branch per event type; a table of
// small readings is easier to check against the ledger than a dispatch map.
function read(w: Working, event: GenesisEvent): Reading {
  const p = obj(event.payload);
  const type = event.type;

  switch (type) {
    // ------------------------------------------------------------- cognition
    case 'GOAL_PROPOSED': {
      const goal = obj(p['goal']);
      return {
        lane: 'HUMAN',
        headline: `Goal proposed: ${str(goal['description']) ?? 'untitled'}`,
        detail: `priority ${num(goal['priority']) ?? 0}`,
      };
    }
    case 'GOAL_STATUS_CHANGED':
      return {
        lane: 'HUMAN',
        headline: `Goal ${str(p['to'])?.toLowerCase() ?? 'changed'}`,
        detail: `${str(p['from']) ?? '?'} → ${str(p['to']) ?? '?'}`,
        severity: str(p['to']) === 'SATISFIED' ? 'SUCCESS' : 'INFO',
      };
    case 'UNCERTAINTY_RECORDED':
      return {
        lane: 'HUMAN',
        headline: `Uncertainty recorded: ${str(obj(p['uncertainty'])['statement']) ?? 'unstated'}`,
        severity: 'WARN',
      };

    // --------------------------------------------------------------- factory
    case 'FACTORY_RUN_STARTED':
      return {
        lane: 'SYSTEM',
        headline: `Run started: ${str(p['title']) ?? 'untitled'}`,
        detail: `up to ${num(p['maxRepairAttempts']) ?? 0} repair attempts`,
        runId: str(p['runId']),
      };
    case 'FACTORY_STAGE_ENTERED': {
      const stage = str(p['stage']);
      const pass = num(p['pass']);
      return {
        lane: stage === null ? 'SYSTEM' : (STAGE_LANES[stage as keyof typeof STAGE_LANES] ?? 'SYSTEM'),
        headline: `${stage === null ? 'Stage' : (STAGE_LABELS[stage as keyof typeof STAGE_LABELS] ?? stage)} started${pass !== null && pass > 1 ? ` (pass ${pass})` : ''}`,
        severity: 'ACTIVE',
        stage,
        pass,
        runId: str(p['runId']),
      };
    }
    case 'FACTORY_STAGE_SETTLED': {
      const stage = str(p['stage']);
      const result = str(p['result']);
      return {
        lane: stage === null ? 'SYSTEM' : (STAGE_LANES[stage as keyof typeof STAGE_LANES] ?? 'SYSTEM'),
        headline: `${stage === null ? 'Stage' : (STAGE_LABELS[stage as keyof typeof STAGE_LABELS] ?? stage)} ${result === 'PASSED' ? 'passed' : result === 'FAILED' ? 'failed' : 'skipped'}`,
        // The factory's own sentence, not a paraphrase of it.
        detail: str(p['detail']),
        severity: result === 'FAILED' ? 'FAILURE' : result === 'PASSED' ? 'SUCCESS' : 'WARN',
        stage,
        pass: num(p['pass']),
        runId: str(p['runId']),
        taskId: str(p['taskId']),
      };
    }
    case 'FACTORY_LEASE_STALE':
      return {
        lane: 'SYSTEM',
        headline: `Impact lease went stale in ${str(p['stage']) ?? 'a stage'}`,
        detail: `${str(p['reason']) ?? ''}${p['willRerun'] === true ? ' — rerunning' : ' — blocking'}`,
        severity: 'WARN',
        stage: str(p['stage']),
        runId: str(p['runId']),
      };
    case 'FACTORY_CHANGE_BLOCKED':
      return {
        lane: 'SYSTEM',
        headline: 'Change blocked',
        detail: str(p['reason']),
        severity: 'FAILURE',
        stage: str(p['stage']),
        runId: str(p['runId']),
      };
    case 'FACTORY_ARTIFACT_VERIFIED':
      return {
        lane: 'VERIFIER',
        headline: `${str(p['path']) ?? 'artifact'} reached ${str(p['state']) ?? 'a state'}`,
        detail: `on ${num(p['evidenceCount']) ?? 0} piece(s) of evidence`,
        severity: 'SUCCESS',
        runId: str(p['runId']),
        artifactId: str(p['artifactId']),
      };
    case 'FACTORY_RUN_FINISHED': {
      const outcome = str(p['outcome']);
      return {
        lane: 'SYSTEM',
        headline: `Run finished: ${outcome ?? 'unknown'}`,
        detail: str(p['summary']),
        severity: outcome === 'VERIFIED' ? 'SUCCESS' : 'FAILURE',
        runId: str(p['runId']),
      };
    }

    // ----------------------------------------------------------- agent tasks
    case 'AGENT_TASK_ASSIGNED': {
      const role = str(p['role']);
      return {
        lane: role === null ? 'SYSTEM' : laneOfRole(role),
        headline: `${role ?? 'Agent'} assigned`,
        detail: `task ${shortId(str(p['taskId']) ?? 'unknown')} · attempt ${num(p['attempt']) ?? 1}`,
        severity: 'ACTIVE',
        taskId: str(p['taskId']),
      };
    }
    case 'AGENT_TASK_STATE_CHANGED': {
      const to = str(p['to']);
      return {
        lane: laneOfTask(w, str(p['taskId'])),
        headline: `Task ${to?.toLowerCase().replace(/_/g, ' ') ?? 'moved'}`,
        detail: str(p['reason']),
        severity: to === 'FAILED' || to === 'CANCELLED' ? 'FAILURE' : to === 'COMPLETED' ? 'SUCCESS' : 'INFO',
        taskId: str(p['taskId']),
      };
    }
    case 'AGENT_TASK_FINISHED': {
      const final = str(p['finalState']);
      return {
        lane: laneOfTask(w, str(p['taskId'])),
        headline: `Task finished ${final ?? ''}`.trim(),
        detail: `${num(p['messages']) ?? 0} message(s) · ${num(p['proposalsAccepted']) ?? 0} proposal(s) accepted`,
        severity: final === 'FAILED' ? 'FAILURE' : 'INFO',
        taskId: str(p['taskId']),
      };
    }
    case 'AGENT_TASK_FAILED':
      return {
        lane: laneOfTask(w, str(p['taskId'])),
        headline: `Agent task failed: ${str(p['kind']) ?? 'unknown'}`,
        detail: str(p['detail']),
        severity: 'FAILURE',
        taskId: str(p['taskId']),
      };
    case 'AGENT_MESSAGE_RECEIVED': {
      const kind = str(p['messageKind']);
      const envelope = obj(p['envelope']);
      const from = obj(envelope['from']);
      const role = str(from['role']);
      return {
        lane: role !== null ? laneOfRole(role) : laneOfTask(w, str(p['taskId'])),
        headline:
          kind === 'EVIDENCE_SUBMISSION'
            ? 'Evidence submitted'
            : kind === 'FINDING'
              ? 'Finding reported'
              : kind === 'RESULT'
                ? 'Result reported'
                : `Message: ${kind ?? 'unknown'}`,
        detail: describeMessage(envelope),
        severity: kind === 'ERROR' ? 'FAILURE' : 'INFO',
        taskId: str(p['taskId']),
      };
    }
    case 'AGENT_MESSAGE_REJECTED':
      return {
        lane: laneOfTask(w, str(p['taskId'])),
        headline: 'Message rejected by the runtime',
        detail: str(p['reason']),
        severity: 'FAILURE',
        taskId: str(p['taskId']),
      };

    // --------------------------------------------------------- orchestration
    case 'TASK_STARTED':
      return { lane: laneOfTask(w, str(p['taskId'])), headline: 'Reasoning run started', taskId: str(p['taskId']) };
    case 'CONTEXT_ASSEMBLED': {
      const manifest = obj(p['manifest']);
      return {
        lane: laneOfTask(w, str(manifest['taskId'])),
        headline: 'Context assembled',
        detail: `${str(manifest['taskKind']) ?? 'task'} · budget ${num(manifest['budgetTokens']) ?? 0} tokens`,
        taskId: str(manifest['taskId']),
      };
    }
    case 'REASONING_REQUESTED':
      return {
        lane: laneOfTask(w, str(p['taskId'])),
        headline: `Asked the model to ${purposeOf(str(p['purpose']))}`,
        detail: `provider ${str(p['providerId']) ?? '?'}`,
        taskId: str(p['taskId']),
      };
    case 'REASONING_RESPONDED': {
      const taskId = w.callTasks.get(str(p['callId']) ?? '') ?? null;
      return {
        lane: laneOfTask(w, taskId),
        headline: 'Model responded',
        detail: `${str(p['modelId']) ?? 'model'} · ${num(p['outputLength']) ?? 0} chars · stop ${str(p['stopReason']) ?? '?'}`,
        taskId,
      };
    }
    case 'REASONING_FAILED': {
      const taskId = w.callTasks.get(str(p['callId']) ?? '') ?? null;
      return {
        lane: laneOfTask(w, taskId),
        headline: `Model call failed: ${str(p['kind']) ?? 'unknown'}`,
        detail: str(p['detail']),
        severity: 'FAILURE',
        taskId,
      };
    }
    case 'REASONING_OUTPUT_REJECTED': {
      const taskId = w.callTasks.get(str(p['callId']) ?? '') ?? null;
      return {
        lane: laneOfTask(w, taskId),
        // The trust boundary, visible: the model said something and the core
        // refused it (ADR-0018).
        headline: 'Model output rejected by the core',
        detail: str(p['reason']),
        severity: 'FAILURE',
        taskId,
      };
    }
    case 'PROPOSAL_EVALUATED': {
      const accepted = p['accepted'] === true;
      return {
        lane: laneOfTask(w, str(p['taskId'])),
        headline: `Proposal ${accepted ? 'accepted' : 'refused'}: ${str(p['kind']) ?? 'unknown'}`,
        detail: str(p['reason']),
        severity: accepted ? 'SUCCESS' : 'WARN',
        taskId: str(p['taskId']),
      };
    }
    case 'TASK_FINISHED':
      return { lane: laneOfTask(w, str(p['taskId'])), headline: 'Reasoning run finished', taskId: str(p['taskId']) };
    case 'EXECUTION_FAILED':
      return {
        lane: laneOfTask(w, str(p['taskId'])),
        headline: 'Execution failed',
        detail: str(p['detail']),
        severity: 'FAILURE',
        taskId: str(p['taskId']),
      };
    case 'TASK_SPLIT_REQUIRED':
      return {
        lane: laneOfTask(w, str(p['taskId'])),
        headline: 'Task too large for its context budget',
        detail: str(p['reason']),
        severity: 'WARN',
        taskId: str(p['taskId']),
      };

    // ------------------------------------------------------------- artifacts
    case 'ARTIFACT_PROPOSED':
      return {
        // Attributed to the Builder, at AI_ASSUMPTION: an artifact is a model's
        // output until evidence says otherwise (ADR-0023 §5).
        lane: laneOfRole(event.actor.agentRole ?? 'BUILDER'),
        headline: `Produced ${str(p['path']) ?? 'an artifact'}`,
        detail: `${num(p['bytes']) ?? 0} bytes · recorded at ${str(p['verificationState']) ?? 'GENERATED'}`,
        artifactId: str(p['artifactId']),
      };
    case 'FAILURE_DIAGNOSED':
      return {
        lane: 'REPAIR',
        headline: `Diagnosed: ${str(p['rootCause']) ?? 'no root cause recorded'}`,
        detail: str(p['approach']) === null ? null : `approach: ${str(p['approach']) as string}`,
        severity: 'WARN',
      };

    default:
      return {
        lane: event.actor.agentRole !== undefined ? laneOfRole(event.actor.agentRole) : 'SYSTEM',
        headline: type.toLowerCase().replace(/_/g, ' '),
        unrecognised: true,
      };
  }
}

/** What a reasoning purpose means in a sentence. */
const purposeOf = (purpose: string | null): string => {
  if (purpose === 'PRODUCE_ARTIFACT') return 'produce an artifact';
  if (purpose === 'DIAGNOSE_FAILURE') return 'diagnose the failure';
  if (purpose === 'PROPOSE_COGNITIVE_UPDATES') return 'propose updates';
  return 'reason';
};

/** A one-line summary of an agent's message, from the envelope it sent. */
function describeMessage(envelope: Record<string, unknown>): string | null {
  const body = obj(envelope['body']);
  const outcome = str(body['outcome']);
  const summary = str(body['summary']);
  if (summary !== null) return outcome === null ? summary : `${outcome}: ${summary}`;
  if (outcome !== null) return outcome;
  const findings = envelope['findings'] ?? body['findings'];
  if (Array.isArray(findings)) return `${findings.length} finding(s)`;
  return null;
}

// --------------------------------------------------------------- the fold

/** Applies one event to the working state. */
function step(w: Working, event: GenesisEvent): void {
  const p = obj(event.payload);

  // Remembered BEFORE the reading, so an event that needs the lookup finds it.
  if (event.type === 'AGENT_TASK_ASSIGNED') {
    const taskId = str(p['taskId']);
    const role = str(p['role']);
    if (taskId !== null && role !== null) w.taskRoles.set(taskId, role);
  }
  if (event.type === 'REASONING_REQUESTED') {
    const callId = str(p['callId']);
    const taskId = str(p['taskId']);
    if (callId !== null && taskId !== null) w.callTasks.set(callId, taskId);
  }

  const r = read(w, event);
  const lane = r.lane ?? 'SYSTEM';
  const view: EventView = {
    seq: event.seq,
    id: event.id,
    type: event.type,
    timestamp: event.timestamp,
    actorKind: event.actor.kind,
    authority: event.authority,
    lane,
    stage: r.stage ?? w.currentStage,
    pass: r.pass ?? w.currentPass,
    headline: r.headline,
    detail: r.detail ?? null,
    severity: r.severity ?? 'INFO',
    runId: r.runId ?? w.run?.runId ?? null,
    taskId: r.taskId ?? null,
    artifactId: r.artifactId ?? null,
    unrecognised: r.unrecognised === true,
  };
  w.events.push(view);
  w.lastSeq = event.seq;
  if (view.unrecognised) w.anomalies.add(event.type);

  const previous = w.lanes.get(lane) ?? blankLane(lane);
  w.lanes.set(lane, {
    ...previous,
    events: previous.events + 1,
    lastSeq: event.seq,
    lastHeadline: view.headline,
    tasks: previous.tasks + (event.type === 'AGENT_TASK_ASSIGNED' ? 1 : 0),
    failures: previous.failures + (view.severity === 'FAILURE' ? 1 : 0),
  });
  // The core's own bookkeeping is not "activity" a reader cares about; the
  // highlighted lane is whichever agent or stage last did something.
  if (lane !== 'SYSTEM') w.activeLane = lane;

  applyStructure(w, event, view, p);
}

/** Updates the goal, run, stage, artifact and finding views. */
function applyStructure(w: Working, event: GenesisEvent, view: EventView, p: Record<string, unknown>): void {
  switch (event.type) {
    case 'GOAL_PROPOSED': {
      const goal = obj(p['goal']);
      const id = str(goal['id']);
      if (id !== null) {
        w.goals.set(id, {
          goalId: id,
          description: str(goal['description']) ?? '',
          status: str(goal['status']) ?? 'PROPOSED',
          priority: num(goal['priority']) ?? 0,
        });
      }
      return;
    }
    case 'GOAL_STATUS_CHANGED': {
      const id = str(p['goalId']);
      const existing = id === null ? undefined : w.goals.get(id);
      if (existing !== undefined && id !== null) {
        w.goals.set(id, { ...existing, status: str(p['to']) ?? existing.status });
      }
      return;
    }
    case 'FACTORY_RUN_STARTED':
      w.run = {
        runId: str(p['runId']) ?? '',
        goalId: str(p['goalId']) ?? '',
        title: str(p['title']) ?? '',
        maxRepairAttempts: num(p['maxRepairAttempts']) ?? 0,
        startedSeq: event.seq,
        outcome: null,
        summary: null,
        stagesRun: null,
        repairAttempts: null,
        highestState: null,
        blockedReason: null,
      };
      return;
    case 'FACTORY_STAGE_ENTERED': {
      const stage = str(p['stage']);
      if (stage === null) return;
      w.currentStage = stage;
      w.currentPass = num(p['pass']);
      w.stages.push({
        stage,
        label: STAGE_LABELS[stage as keyof typeof STAGE_LABELS] ?? stage,
        pass: num(p['pass']) ?? 1,
        lane: STAGE_LANES[stage as keyof typeof STAGE_LANES] ?? 'SYSTEM',
        enteredSeq: event.seq,
        settledSeq: null,
        result: 'RUNNING',
        detail: null,
        taskId: null,
      });
      return;
    }
    case 'FACTORY_STAGE_SETTLED': {
      const stage = str(p['stage']);
      const pass = num(p['pass']);
      // The last matching entry: a stage can be entered more than once, and a
      // settle belongs to the most recent pass of it.
      for (let i = w.stages.length - 1; i >= 0; i -= 1) {
        const candidate = w.stages[i] as StageView;
        if (candidate.stage !== stage || candidate.pass !== pass || candidate.settledSeq !== null) continue;
        w.stages[i] = {
          ...candidate,
          settledSeq: event.seq,
          result: (str(p['result']) as StageView['result']) ?? 'PASSED',
          detail: str(p['detail']),
          taskId: str(p['taskId']),
        };
        break;
      }
      return;
    }
    case 'FACTORY_CHANGE_BLOCKED': {
      if (w.run !== null) w.run = { ...w.run, blockedReason: str(p['reason']) };
      const blocking = p['blocking'];
      if (Array.isArray(blocking)) {
        for (const raw of blocking) {
          const f = obj(raw);
          w.findings.push({
            rule: str(f['rule']) ?? 'unknown',
            severity: str(f['severity']) ?? 'INFO',
            artifactId: str(f['artifactId']) ?? '',
            detail: str(f['detail']) ?? '',
            blocking: true,
            seq: event.seq,
          });
        }
      }
      return;
    }
    case 'FACTORY_ARTIFACT_VERIFIED': {
      const id = str(p['artifactId']);
      const existing = id === null ? undefined : w.artifacts.get(id);
      if (id !== null && existing !== undefined) {
        w.artifacts.set(id, {
          ...existing,
          state: str(p['state']) ?? existing.state,
          evidenceCount: num(p['evidenceCount']) ?? existing.evidenceCount,
          verifiedSeq: event.seq,
        });
      }
      return;
    }
    case 'FACTORY_RUN_FINISHED':
      if (w.run !== null) {
        w.run = {
          ...w.run,
          outcome: str(p['outcome']),
          summary: str(p['summary']),
          stagesRun: num(p['stagesRun']),
          repairAttempts: num(p['repairAttempts']),
          highestState: str(p['highestState']),
        };
      }
      w.currentStage = null;
      w.currentPass = null;
      return;
    case 'ARTIFACT_PROPOSED': {
      const id = str(p['artifactId']);
      if (id === null) return;
      w.artifacts.set(id, {
        artifactId: id,
        path: str(p['path']) ?? '',
        contentHash: str(p['contentHash']) ?? '',
        bytes: num(p['bytes']) ?? 0,
        language: str(p['language']),
        contents: str(p['contents']),
        proposedBy: event.actor.agentRole ?? null,
        proposedSeq: event.seq,
        state: str(p['verificationState']) ?? 'GENERATED',
        evidenceCount: 0,
        verifiedSeq: null,
      });
      return;
    }
    case 'AGENT_MESSAGE_RECEIVED': {
      if (str(p['messageKind']) !== 'FINDING') return;
      const envelope = obj(p['envelope']);
      const findings = envelope['findings'] ?? obj(envelope['body'])['findings'];
      if (!Array.isArray(findings)) return;
      for (const raw of findings) {
        const f = obj(raw);
        w.findings.push({
          rule: str(f['rule']) ?? str(f['id']) ?? 'unknown',
          severity: str(f['severity']) ?? 'INFO',
          artifactId: str(f['artifactId']) ?? '',
          detail: str(f['detail']) ?? str(f['message']) ?? '',
          blocking: false,
          seq: event.seq,
        });
      }
      return;
    }
    default:
      // Nothing structural. The event is still in the timeline.
      void view;
  }
}

/** Folds a whole history into the view. Pure: same events, same view. */
export function foldConsole(events: readonly GenesisEvent[]): ConsoleState {
  const w = start();
  for (const event of events) step(w, event);
  return freeze(w);
}

/**
 * Folds more events onto a view, for a live stream.
 *
 * Re-folds from the beginning rather than keeping mutable state between calls.
 * A console that accumulated state across a reconnect would drift from the
 * ledger, and the ledger is the only thing worth agreeing with.
 */
export function foldMore(previous: readonly GenesisEvent[], next: readonly GenesisEvent[]): ConsoleState {
  return foldConsole([...previous, ...next]);
}

function freeze(w: Working): ConsoleState {
  return {
    goals: [...w.goals.values()],
    run: w.run,
    stages: [...w.stages],
    artifacts: [...w.artifacts.values()],
    findings: [...w.findings],
    lanes: Object.fromEntries(w.lanes) as Record<Lane, LaneView>,
    events: [...w.events],
    activeLane: w.activeLane,
    lastSeq: w.lastSeq,
    anomalies: [...w.anomalies].sort(),
  };
}

/** The view of one event, in isolation, for a live stream. */
export function describeOne(history: readonly GenesisEvent[], event: GenesisEvent): EventView {
  const state = foldConsole([...history, event]);
  return state.events[state.events.length - 1] as EventView;
}
