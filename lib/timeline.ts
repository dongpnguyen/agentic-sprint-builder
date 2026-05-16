import type { AgentEvent, RunResult } from '@/lib/types';

function hasDeployEvent(events: AgentEvent[]) {
  return events.some((event) => event.agentId === 'deploy');
}

function createDerivedDeployEvent(result: RunResult): AgentEvent {
  if (result.deploymentOutput) {
    return {
      agentId: 'deploy',
      eventType: 'WORK_COMPLETE',
      task: 'Deployment completed; event derived from saved deployment artifacts',
      timestamp: result.events.at(-1)?.timestamp ?? result.createdAt,
      dashboardAccepted: false
    };
  }

  return {
    agentId: 'deploy',
    eventType: 'IDLE',
    task: 'Deployment skipped because code review did not pass',
    timestamp: result.events.at(-1)?.timestamp ?? result.createdAt,
    dashboardAccepted: false
  };
}

export function getRunTimelineEvents(result: RunResult) {
  if (hasDeployEvent(result.events)) return result.events;

  const derivedDeployEvent = createDerivedDeployEvent(result);
  const skippedIndex = result.events.findIndex(
    (event) => event.agentId === 'qa' && /deployment skipped/i.test(event.task)
  );

  if (skippedIndex >= 0) {
    return [
      ...result.events.slice(0, skippedIndex + 1),
      derivedDeployEvent,
      ...result.events.slice(skippedIndex + 1)
    ];
  }

  return [...result.events, derivedDeployEvent];
}
