// YinwuRealm Upptime scheduler. Author: Soidraw.
// Paste this whole file into a Cloudflare module Worker.
// Secret: GITHUB_DISPATCH_TOKEN. Cron Trigger: * * * * * (UTC).
// The Worker checks this timetable each minute; uptime checks run every five.

const REPOSITORY = 'YinwuPotato/yinwurealm-status';
const BRANCH = 'master';
const API_BASE = `https://api.github.com/repos/${REPOSITORY}`;

// Maintenance is offset from the uptime slots to reduce concurrency conflicts.
// Keep these times in sync with README.md in this directory.
const TASKS = [
  { workflow: 'uptime.yml', minutes: [3, 8, 13, 18, 23, 28, 33, 38, 43, 48, 53, 58] },
  { workflow: 'response-time.yml', minutes: [17], hours: [0, 6, 12, 18] },
  { workflow: 'summary.yml', minutes: [25], hours: [0] },
  { workflow: 'graphs.yml', minutes: [35], hours: [0] },
  { workflow: 'site.yml', minutes: [45], hours: [0] },
  { workflow: 'update-template.yml', minutes: [15], hours: [3], weekdays: [1] },
  { workflow: 'updates.yml', minutes: [30], hours: [3] },
];

function dueWorkflows(scheduledTime) {
  if (typeof scheduledTime !== 'number' || !Number.isFinite(scheduledTime)) {
    throw new Error('Invalid scheduledTime.');
  }
  const date = new Date(scheduledTime);
  if (Number.isNaN(date.getTime())) throw new Error('Invalid scheduledTime.');
  return TASKS.filter(task =>
    task.minutes.includes(date.getUTCMinutes()) &&
    (!task.hours || task.hours.includes(date.getUTCHours())) &&
    (!task.weekdays || task.weekdays.includes(date.getUTCDay()))
  ).map(task => task.workflow);
}

async function dispatch(workflow, token) {
  let response;
  let request;
  let phase = 'setup';
  try {
    request = new Request(`${API_BASE}/actions/workflows/${workflow}/dispatches`, {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Soidraw-Upptime-Scheduler',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({ ref: BRANCH }),
      signal: AbortSignal.timeout(15000),
      // workerd rejects redirect: 'error' before sending the request.
      // Never follow redirects with the Authorization header attached.
      redirect: 'manual',
    });
    phase = 'fetch';
    response = await fetch(request);
  } catch (error) {
    // Do not retry an ambiguous POST: GitHub may already have accepted it.
    // Do not log the original error, headers, or Secret.
    const name = ['TypeError', 'RangeError', 'ReferenceError', 'TimeoutError', 'AbortError'].includes(error?.name)
      ? error.name : 'Error';
    const reason = phase === 'setup' ? 'setup failed'
      : request.signal.aborted ? 'timed out' : 'failed';
    throw new Error(`GitHub request ${reason}: ${workflow} (${name}). Check Actions before retrying.`);
  }
  if (response.status >= 300 && response.status < 400) {
    throw new Error(`GitHub redirect refused: ${workflow}, HTTP ${response.status}.`);
  }
  if (response.status !== 204) {
    // Response bodies can contain reflected request data; report only status.
    throw new Error(`GitHub rejected ${workflow}: HTTP ${response.status}.`);
  }
}

export default {
  async scheduled(controller, env) {
    if (controller.cron !== '* * * * *') {
      throw new Error('Set the Cloudflare Cron Trigger to: * * * * *');
    }
    // Use the scheduled slot, so a slightly delayed invocation still selects
    // the task assigned to that slot, including daily maintenance.
    const workflows = dueWorkflows(controller.scheduledTime);
    if (!workflows.length) return;
    const token = env.GITHUB_DISPATCH_TOKEN;
    if (typeof token !== 'string' || !token.trim()) {
      throw new Error('Missing Cloudflare Secret: GITHUB_DISPATCH_TOKEN.');
    }
    for (const workflow of workflows) {
      try {
        await dispatch(workflow, token.trim());
        console.log(JSON.stringify({
          event: 'dispatch_accepted',
          workflow,
          scheduled_at: new Date(controller.scheduledTime).toISOString(),
        }));
      } catch (error) {
        console.error(error.message);
        throw error;
      }
    }
  },

  // A public visit must never start a GitHub workflow or reveal a Secret.
  async fetch() {
    return new Response('Not found. This Worker runs through Cron Triggers.\n', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  },
};
