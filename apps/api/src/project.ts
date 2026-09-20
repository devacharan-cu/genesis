/**
 * One project: a real GENESIS runtime, wired from the real packages.
 *
 * Every project gets its own ledger, its own cognitive engine, its own agent
 * registry and its own factory. Nothing is shared between projects and nothing
 * is global, which is project isolation (ADR-0008) holding in the demo server
 * as well as in the stores.
 *
 * The one thing added here is `WatchedLedger`, and it is deliberately not a
 * ledger of its own: it delegates every method to the real one and, after an
 * append lands, tells listeners that history has moved. Listeners then READ the
 * ledger. That is the same discipline as the DynamoDB stream in P8 — a
 * notification is a signal, the ledger is the record — and it is why nothing
 * downstream can end up acting on a copy of history that was never verified.
 */

import { AgentRegistry, BuilderAgent, PlannerAgent, QaAgent, RepairAgent, SecurityAgent } from '@genesis/agents';
import { CognitiveEngine } from '@genesis/cognition';
import { AgentRuntime, Orchestrator, PROPOSAL_KINDS } from '@genesis/core';
import { FactoryRunId, type GenesisEvent, newAgentId, newProjectId, type ProjectScope, projectScope } from '@genesis/core-types';
import { LocalSandboxProvider } from '@genesis/adapters-sandbox-local';
import { type FactoryOutcome, SoftwareFactory } from '@genesis/factory';
import { InMemoryGraphStore } from '@genesis/graph';
import { InMemoryEventLedger } from '@genesis/ledger';
import type { AppendOptions, EventLedger, ReadOptions } from '@genesis/ledger';
import { InMemoryMemoryStore } from '@genesis/memory';
import { AgentManifest, defaultRoleConfig } from '@genesis/protocol';
import { MockReasoningProvider } from '@genesis/reasoning';
import { VerificationEngine } from '@genesis/verification';
import { planFor, type ScenarioName } from './scenarios.js';

/**
 * A ledger that says when it has moved.
 *
 * It adds no storage, no ordering and no truth. `append` is the real append; a
 * listener is told afterwards, and a listener that wants events reads them.
 */
export class WatchedLedger implements EventLedger {
  readonly #inner: EventLedger;
  readonly #listeners = new Set<() => void>();

  constructor(inner: EventLedger) {
    this.#inner = inner;
  }

  /** Returns an unsubscribe. Failing listeners are contained, never propagated. */
  watch(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #announce(): void {
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        // A broken listener must not fail an append that already landed.
      }
    }
  }

  async append(scope: ProjectScope, input: unknown): Promise<GenesisEvent> {
    const event = await this.#inner.append(scope, input);
    this.#announce();
    return event;
  }

  async appendMany(scope: ProjectScope, inputs: readonly unknown[], options?: AppendOptions): Promise<GenesisEvent[]> {
    const events = await this.#inner.appendMany(scope, inputs, options);
    if (events.length > 0) this.#announce();
    return events;
  }

  get(scope: ProjectScope, id: Parameters<EventLedger['get']>[1]): ReturnType<EventLedger['get']> {
    return this.#inner.get(scope, id);
  }
  at(scope: ProjectScope, seq: number): ReturnType<EventLedger['at']> {
    return this.#inner.at(scope, seq);
  }
  read(scope: ProjectScope, options?: ReadOptions): Promise<GenesisEvent[]> {
    return this.#inner.read(scope, options);
  }
  head(scope: ProjectScope): ReturnType<EventLedger['head']> {
    return this.#inner.head(scope);
  }
  count(scope: ProjectScope): Promise<number> {
    return this.#inner.count(scope);
  }
  verify(scope: ProjectScope, options?: ReadOptions): ReturnType<EventLedger['verify']> {
    return this.#inner.verify(scope, options);
  }
  replay(
    scope: ProjectScope,
    onEvent: Parameters<EventLedger['replay']>[1],
    options?: Parameters<EventLedger['replay']>[2],
  ): ReturnType<EventLedger['replay']> {
    return this.#inner.replay(scope, onEvent, options);
  }
  close(): Promise<void> {
    this.#listeners.clear();
    return this.#inner.close();
  }
}

export type RunStatus = 'IDLE' | 'RUNNING' | 'FINISHED' | 'ERRORED';

export interface Project {
  readonly projectId: string;
  readonly scope: ProjectScope;
  readonly intent: string;
  readonly scenario: ScenarioName;
  readonly goalId: string;
  readonly ledger: WatchedLedger;
  readonly createdAt: string;
  status: RunStatus;
  /** Set only when the run itself could not be carried out. */
  error: string | null;
  outcome: FactoryOutcome | null;
}

const manifest = (role: string): AgentManifest =>
  AgentManifest.parse({
    id: newAgentId(),
    role,
    version: '1.0.0',
    capabilities: ['factory'],
    maxContextTokens: 4000,
    timeoutMs: 30_000,
    // A Planner may propose a belief; a Builder, QA and Security may not
    // propose anything at all (ADR-0020 §3). The manifest is the ceiling.
    proposalKinds: role === 'PLANNER' || role === 'ARCHITECT' ? ['RECORD_BELIEF'] : [],
    reasoningProvider: role === 'QA' || role === 'SECURITY' ? null : 'mock',
  });

/**
 * Creates a project and records the human's intent as a real goal.
 *
 * The goal is created through the cognitive engine, so it is decided and
 * appended by the core rather than written by this server — the API cannot mint
 * state, it can only ask the core to (ADR-0006).
 */
export async function createProject(intent: string, scenario: ScenarioName): Promise<Project> {
  const scope = projectScope(newProjectId());
  const ledger = new WatchedLedger(new InMemoryEventLedger());
  const engine = new CognitiveEngine(ledger);

  await engine.execute(
    scope,
    { kind: 'HUMAN', id: 'console-operator' },
    {
      kind: 'PROPOSE_GOAL',
      description: intent,
      priority: 80,
      successCriteria: [
        { statement: 'the built artifact passes its test in the sandbox', checkKind: 'TEST', checkRef: 'test:unit' },
      ],
    },
  );
  const state = await engine.state(scope);
  const goals = (state.state as { goals: Record<string, unknown> }).goals;
  const goalId = Object.keys(goals)[0];
  if (goalId === undefined) throw new Error('the core recorded no goal for this intent');
  await engine.execute(scope, { kind: 'HUMAN', id: 'console-operator' }, { kind: 'ACTIVATE_GOAL', goalId });

  return {
    projectId: scope.projectId,
    scope,
    intent,
    scenario,
    goalId,
    ledger,
    createdAt: new Date().toISOString(),
    status: 'IDLE',
    error: null,
    outcome: null,
    // The engine is rebuilt per run below, from the same ledger, so nothing
    // depends on state held here between a project's creation and its run.
  };
}

/**
 * Runs the factory for a project. Resolves when the run has finished.
 *
 * Everything in here is the real implementation: the agents from P6, the
 * factory from P7, a real sandbox executing real `node`, and the verification
 * engine from P5 ruling on the evidence that produced.
 */
export async function runFactory(project: Project): Promise<FactoryOutcome> {
  const plan = planFor(project.scenario, project.intent);
  const engine = new CognitiveEngine(project.ledger);
  const config = defaultRoleConfig();

  const registry = new AgentRegistry({
    proposalKinds: [...PROPOSAL_KINDS],
    permissions: [],
    tools: [],
    reasoningProviders: ['mock'],
  });
  registry.register(new PlannerAgent(manifest('PLANNER')));
  registry.register(new PlannerAgent(manifest('ARCHITECT')));
  registry.register(new BuilderAgent(manifest('BUILDER'), config));
  registry.register(new QaAgent(manifest('QA'), config));
  registry.register(new SecurityAgent(manifest('SECURITY'), config));
  registry.register(new RepairAgent(manifest('REPAIR'), config));

  const graph = new InMemoryGraphStore();
  const provider = new MockReasoningProvider((request) => plan.script(request.purpose, 0));
  const orchestrator = new Orchestrator({
    ledger: project.ledger,
    engine,
    provider,
    memory: new InMemoryMemoryStore(),
    graph,
    reasoning: { timeoutMs: 30_000, maxOutputTokens: 4096 },
  });
  const runtime = new AgentRuntime({ ledger: project.ledger, engine, registry, orchestrator });

  let counter = 0;
  const factory = new SoftwareFactory({
    ledger: project.ledger,
    runtime,
    graph,
    verifier: new VerificationEngine(),
    sandbox: new LocalSandboxProvider(),
    config,
    ids: { run: () => FactoryRunId.parse(`run_${String((counter += 1)).padStart(26, '0')}`) },
  });

  return factory.build(project.scope, {
    goalId: project.goalId,
    title: project.intent.slice(0, 120),
    specification: project.intent,
    testCommand: plan.testCommand,
    testKind: 'UNIT',
    testTimeoutMs: 30_000,
  });
}
