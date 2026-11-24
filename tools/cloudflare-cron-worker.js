// Cloudflare Worker: starts the GitHub "Refresh data and deploy" workflow on a reliable timer.
// GitHub's own schedule often drops or delays runs; Cloudflare Cron Triggers fire on time.
//
// Setup (Cloudflare dashboard → Workers & Pages → your worker):
//   1. Paste this file as the worker code and Deploy.
//   2. Settings → Variables and Secrets → add a Secret named GITHUB_TOKEN
//      (a fine-grained GitHub token for this repo only, permission "Actions: Read and write").
//   3. Settings → Trigger events → add a Cron Trigger: 0 6-20/2 * * *
//      (UTC: every 2 hours, 8 AM–10 PM Cairo winter time).

const REPO = 'karimibrahim8/Fulfil-Dashboard';
const WORKFLOW = 'refresh.yml';

async function startRefresh(env) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'fulfil-dashboard-cron',
    },
    body: JSON.stringify({ ref: 'main' }),
  });
  if (res.status !== 204) {
    throw new Error(`GitHub answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
}

export default {
  // Runs on the Cron Trigger.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(startRefresh(env));
  },
  // Visiting the worker's URL only shows a note; it does not start a refresh.
  async fetch() {
    return new Response('Fulfilment Dashboard refresh timer. Refreshes run on the Cron Trigger.', {
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  },
};
