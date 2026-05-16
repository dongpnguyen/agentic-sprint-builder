import type { AgentEvent, AgentId, DashboardEventType } from '@/lib/types';

const AGENTS = [
  { agent_id: 'ba', name: 'Alice BA', role: 'analyst' },
  { agent_id: 'asset', name: 'Aria ASSET', role: 'asset' },
  { agent_id: 'dev', name: 'Bob DEV', role: 'dev' },
  { agent_id: 'qa', name: 'Carol QA', role: 'qa' },
  { agent_id: 'deploy', name: 'Dana DEPLOY', role: 'deploy' }
];

export interface DashboardClient {
  emit(event: {
    agent: string;
    type: string;
    to?: string;
    payload?: any;
  }): Promise<void>;
}

function isDashboardEnabled() {
  return process.env.ENABLE_DASHBOARD === 'true';
}

export async function registerDashboardCompany() {
  if (!isDashboardEnabled()) {
    return {
      company_id: 'mock-company',
      name: 'Agentic Sprint Builder',
      created_at: new Date().toISOString(),
      mocked: true,
      dashboardDisabled: true
    };
  }

  const baseUrl =
    process.env.DASHBOARD_BASE_URL ||
    'https://aitechcontest.kms-technology.com/api';

  const response = await fetch(`${baseUrl}/companies`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: process.env.DASHBOARD_COMPANY_NAME || 'Agentic Sprint Builder',
      description: 'Markdown-skill multi-agent software delivery team',
      agents: AGENTS
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Dashboard register failed ${response.status}: ${body}`);
  }

  return response.json();
}

export async function emitDashboardEvent(params: {
  agentId: AgentId;
  eventType: DashboardEventType;
  task: string;
  toAgent?: AgentId;
  artifact?: string;
}): Promise<AgentEvent> {
  const event: AgentEvent = {
    agentId: params.agentId,
    eventType: params.eventType,
    task: params.task,
    toAgent: params.toAgent,
    timestamp: new Date().toISOString(),
    dashboardAccepted: false
  };

  if (!isDashboardEnabled()) {
    return {
      ...event,
      dashboardAccepted: false,
      mocked: true
    } as AgentEvent;
  }

  const companyId = process.env.DASHBOARD_COMPANY_ID;
  if (!companyId) return event;

  const baseUrl =
    process.env.DASHBOARD_BASE_URL ||
    'https://aitechcontest.kms-technology.com/api';

  try {
    const response = await fetch(`${baseUrl}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        company_id: companyId,
        agent_id: params.agentId,
        event_type: params.eventType,
        to_agent: params.toAgent,
        payload: {
          task: params.task,
          artifact: params.artifact,
          agent_state: params.eventType.toLowerCase()
        }
      })
    });

    event.dashboardAccepted = response.ok;
  } catch {
    event.dashboardAccepted = false;
  }

  return event;
}
