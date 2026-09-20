import express from 'express';
import cors from 'cors';
import { AgentRegistry, BuilderAgent, PlannerAgent, QaAgent, RepairAgent, SecurityAgent } from '@genesis/agents';
import { CognitiveEngine } from '@genesis/cognition';
import { AgentRuntime, Orchestrator, PROPOSAL_KINDS } from '@genesis/core';
import { FactoryRunId, newAgentId, newProjectId, projectScope } from '@genesis/core-types';
import { LocalSandboxProvider } from '@genesis/adapters-sandbox-local';
import { InMemoryGraphStore } from '@genesis/graph';
import { SqliteEventLedger } from '@genesis/adapters-sqlite';
import { InMemoryMemoryStore } from '@genesis/memory';
import { AgentManifest, defaultRoleConfig } from '@genesis/protocol';
import { MockReasoningProvider } from '@genesis/reasoning';
import { VerificationEngine } from '@genesis/verification';
import { SoftwareFactory } from '@genesis/factory';

const app = express();
app.use(cors());

const ledger = new SqliteEventLedger(':memory:');
const engine = new CognitiveEngine(ledger);

// Keep track of connected clients
const clients = new Set<express.Response>();

// Poll ledger and push events
let lastSeq = 0;

let pollInterval: NodeJS.Timeout | null = null;

app.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  clients.add(res);
  res.write(`data: ${JSON.stringify({ node: 'system', msg: 'Connected to GENESIS Event Stream' })}\n\n`);

  req.on('close', () => {
    clients.delete(res);
  });
});

app.post('/start', async (req, res) => {
  try {
    const scope = projectScope(newProjectId());

    const manifest = (role: string): AgentManifest => AgentManifest.parse({
      id: newAgentId(), role, version: '1.0.0', capabilities: ['factory'],
      maxContextTokens: 4000, timeoutMs: 20_000,
      proposalKinds: role === 'PLANNER' || role === 'ARCHITECT' ? ['RECORD_BELIEF'] : [],
      reasoningProvider: role === 'QA' || role === 'SECURITY' ? null : 'mock',
    });

    const registry = new AgentRegistry({ proposalKinds: [...PROPOSAL_KINDS], permissions: [], tools: [], reasoningProviders: ['mock'] });
    const roleConfig = defaultRoleConfig();
    registry.register(new PlannerAgent(manifest('PLANNER')));
    registry.register(new PlannerAgent(manifest('ARCHITECT')));
    registry.register(new BuilderAgent(manifest('BUILDER'), roleConfig));
    registry.register(new QaAgent(manifest('QA'), roleConfig));
    registry.register(new SecurityAgent(manifest('SECURITY'), roleConfig));
    registry.register(new RepairAgent(manifest('REPAIR'), roleConfig));

    const graph = new InMemoryGraphStore();
    const mockScript = [
      { output: { proposals: [] } }, // PLAN
      { output: { proposals: [] } }, // ARCHITECT
      { output: { artifacts: [{ path: 'src/add.js', contents: 'exports.add = (a, b) => a + b;\n' }] } } // BUILD
    ];

    const orchestrator = new Orchestrator({
      ledger, engine, provider: new MockReasoningProvider(mockScript as never), memory: new InMemoryMemoryStore(), graph,
      reasoning: { timeoutMs: 20_000, maxOutputTokens: 4096 },
    });

    const runtime = new AgentRuntime({ ledger, engine, registry, orchestrator });
    
    let run = 0;
    const factory = new SoftwareFactory({
      ledger, runtime, graph, verifier: new VerificationEngine(), sandbox: new LocalSandboxProvider(), config: roleConfig,
      ids: { run: () => FactoryRunId.parse(`run_${String((run += 1)).padStart(26, '0')}`) },
    });

    // Seed goal
    await ledger.append(scope, {
      type: 'GOAL_ESTABLISHED',
      actor: { kind: 'HUMAN', id: 'human-1' },
      authority: 'HUMAN_DECISION',
      payload: { goal: { id: 'goal-1', description: 'Build add.js', priority: 1, constraints: [] } },
    });

    // Start polling
    if (pollInterval) clearInterval(pollInterval);
    lastSeq = 0;
    pollInterval = setInterval(async () => {
      const events = await ledger.read(scope, { after: lastSeq });
      for (const ev of events) {
        lastSeq = ev.seq;
        let node = 'system';
        let msg = ev.type;

        const payload = ev.payload as Record<string, unknown> || {};

        if (ev.type === 'FACTORY_RUN_STARTED') { node = 'system'; msg = 'Starting Factory Run'; }
        else if (ev.type === 'FACTORY_STAGE_ENTERED') {
          node = String(payload.stage).toLowerCase().split('_')[0];
          msg = `Entered ${String(payload.stage)} stage`;
        }
        else if (ev.type === 'AGENT_ASSIGNED') { node = 'system'; msg = `Assigned ${String(payload.role)}`; }
        else if (ev.type === 'PROPOSAL_RAISED') { node = 'architect'; msg = `Proposed architecture constraint`; }
        else if (ev.type === 'ARTIFACT_GENERATED') { node = 'builder'; msg = `Generated artifact ${String(payload.path)}`; }
        else if (ev.type === 'EXPERIMENT_COMPLETED') { node = 'qa'; msg = `Executed tests against artifact`; }
        else if (ev.type === 'ARTIFACT_VERIFIED') { node = 'verifier'; msg = `Artifact VERIFIED. Signature valid.`; }

        const out = `data: ${JSON.stringify({ node, msg, kind: ev.type })}\n\n`;
        clients.forEach(c => c.write(out));
      }
    }, 200);

    // Fire off build asynchronously
    factory.build(scope, {
      goalId: 'goal-1', title: 'Add numbers', command: 'Add two numbers', sourcePath: '.', testCommand: ['node', '-e', 'const a=require("./src/add.js");if(a.add(1,2)!==3)process.exit(1);console.error("src/add.js ok")'], testTimeoutMs: 5000,
    }).then(() => {
      clients.forEach(c => c.write(`data: ${JSON.stringify({ node: 'system', msg: 'Demo flow completed successfully.' })}\n\n`));
    }).catch(err => {
      clients.forEach(c => c.write(`data: ${JSON.stringify({ node: 'system', msg: `Error: ${(err as Error).message}` })}\n\n`));
    });

    res.json({ ok: true });
  } catch (err: unknown) {
    const error = err as Error & { details?: unknown };
    console.error('API Error:', error.message);
    if (error.details) console.error('Details:', JSON.stringify(error.details, null, 2));
    res.status(500).json({ error: error.message });
  }
});

app.listen(3001, () => {
  console.warn('API Server running on port 3001');
});
