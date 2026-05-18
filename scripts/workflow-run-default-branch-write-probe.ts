import { writeFileSync } from "fs";
import { execFileSync } from "child_process";

const repoDir = process.env.GITHUB_ACTION_PATH || "/tmp/claude-code-action";
const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
const token = process.env.GITHUB_TOKEN;

if (!token) {
  throw new Error("GITHUB_TOKEN is required");
}

process.env.GITHUB_API_URL = process.env.GITHUB_API_URL || "https://api.github.com";
process.env.GITHUB_EVENT_NAME = process.env.GITHUB_EVENT_NAME || "workflow_run";

const { parseGitHubContext } = await import(`${repoDir}/src/github/context.ts`);
const { prepareAgentMode } = await import(`${repoDir}/src/modes/agent/index.ts`);
const { Client } = await import(
  `${repoDir}/node_modules/@modelcontextprotocol/sdk/dist/cjs/client/index.js`
);
const { StdioClientTransport } = await import(
  `${repoDir}/node_modules/@modelcontextprotocol/sdk/dist/cjs/client/stdio.js`
);
const { Octokit } = await import(`${repoDir}/node_modules/@octokit/rest/dist-src/index.js`);

const context = parseGitHubContext();
const octokit = new Octokit({
  auth: token,
  baseUrl: process.env.GITHUB_API_URL,
});

const gitBranch = (() => {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: workspace,
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
})();

const probePath = `probe-${process.env.GITHUB_RUN_ID || "local"}.txt`;
const probeContent = `written-by-live-probe-${Date.now()}\n`;
writeFileSync(`${workspace}/${probePath}`, probeContent);

const prepareResult = await prepareAgentMode({
  context,
  octokit: { rest: octokit.rest } as any,
  githubToken: token,
});

const mcpConfig = JSON.parse(prepareResult.mcpConfig);
const fileOps = mcpConfig.mcpServers.github_file_ops;

if (!fileOps) {
  throw new Error("github_file_ops server was not configured");
}

const transport = new StdioClientTransport({
  command: "bun",
  args: ["run", `${repoDir}/src/mcp/github-file-ops-server.ts`],
  env: {
    ...process.env,
    ...fileOps.env,
    GITHUB_API_URL: process.env.GITHUB_API_URL,
  },
});

const client = new Client({ name: "live-probe-client", version: "1.0.0" });
await client.connect(transport);
const commitResult = await client.callTool({
  name: "commit_files",
  arguments: {
    files: [probePath],
    message: "live workflow_run branch probe",
  },
});
await client.close();

const owner = context.repository.owner;
const repo = context.repository.repo;
const defaultBranch = context.repository.default_branch || "main";
const headBranch =
  context.eventName === "workflow_run"
    ? context.payload.workflow_run.head_branch
    : null;

async function branchHasFile(branch: string | null) {
  if (!branch) return null;
  const response = await fetch(
    `${process.env.GITHUB_API_URL}/repos/${owner}/${repo}/contents/${probePath}?ref=${encodeURIComponent(branch)}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  return response.ok;
}

const defaultBranchHasFile = await branchHasFile(defaultBranch);
const headBranchHasFile = await branchHasFile(headBranch);

console.log(
  JSON.stringify(
    {
      eventName: context.eventName,
      actor: context.actor,
      workflowRunHeadBranch: headBranch,
      defaultBranch,
      githubRef: process.env.GITHUB_REF || null,
      githubRefName: process.env.GITHUB_REF_NAME || null,
      checkoutGitBranch: gitBranch,
      mcpConfiguredBranch: fileOps.env.BRANCH_NAME,
      mcpConfiguredBaseBranch: fileOps.env.BASE_BRANCH,
      probePath,
      defaultBranchHasFile,
      headBranchHasFile,
      commitResult,
    },
    null,
    2,
  ),
);
