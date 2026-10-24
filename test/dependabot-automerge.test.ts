import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const directories: string[] = [];
afterEach(() =>
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })),
);
const temporary = () => {
  const directory = mkdtempSync(join(tmpdir(), "bridge-automerge-"));
  directories.push(directory);
  return directory;
};
const step = (file: string, name: string) => {
  const source = readFileSync(file, "utf8");
  const start = source.indexOf(`- name: ${name}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const block = source.slice(start).split("        run: |\n")[1];
  expect(block).toBeDefined();
  const lines: string[] = [];
  for (const line of (block ?? "").split("\n")) {
    if (line.trim() && !line.startsWith("          ")) break;
    lines.push(line.slice(10));
  }
  return lines.join("\n");
};
const policyScript = step(".github/workflows/ci.yml", "Check stable package updates");
const mergeScript = step(
  ".github/workflows/dependabot-automerge.yml",
  "Merge an eligible package update",
);
const head = "a".repeat(40);
const base = "b".repeat(40);
const repository = { id: 123, full_name: "ha-chi88/safe-webview-bridge" };
const bot = { id: 49699333, login: "dependabot[bot]", type: "Bot" };
const fixture = () => ({
  run: {
    id: 42,
    path: ".github/workflows/ci.yml",
    event: "pull_request",
    status: "completed",
    conclusion: "success",
    actor: bot,
    head_repository: repository,
    repository,
    head_sha: head,
    pull_requests: [{ number: 8, head: { sha: head }, base: { sha: base } }],
  },
  pr: {
    number: 8,
    state: "open",
    draft: false,
    merged: false,
    user: bot,
    head: { sha: head, ref: "dependabot/npm_and_yarn/example-1.2.4", repo: repository },
    base: { sha: base, ref: "main", repo: repository },
    changed_files: 2,
    commits: 1,
    mergeable: true,
    mergeable_state: "clean",
  },
  jobs: [
    {
      jobs: ["Quality", "Dependabot metadata", "Dependabot eligible"].map((name) => ({
        name,
        status: "completed",
        conclusion: "success",
      })),
    },
  ],
  files: [
    [
      { filename: "package.json", status: "modified" },
      { filename: "pnpm-lock.yaml", status: "modified" },
    ],
  ],
  before: {
    name: "safe-webview-bridge",
    scripts: { check: "vitest" },
    dependencies: { example: "^1.2.3" },
    devDependencies: {},
  },
  after: {
    name: "safe-webview-bridge",
    scripts: { check: "vitest" },
    dependencies: { example: "^1.2.4" },
    devDependencies: {},
  },
  commits: [
    [
      {
        author: bot,
        committer: { id: 19864447, login: "web-flow" },
        commit: { verification: { verified: true, reason: "valid" } },
      },
    ],
  ],
  rules: [
    [
      { type: "pull_request" },
      { type: "deletion" },
      { type: "non_fast_forward" },
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: [{ context: "Quality", integration_id: 15368 }],
        },
      },
    ],
  ],
  latest: 42,
  base,
});

const executeMerge = (data: ReturnType<typeof fixture>, dryRun = false) => {
  const directory = temporary();
  const fixturePath = join(directory, "fixture.json");
  const mergePath = join(directory, "merge.json");
  const summary = join(directory, "summary.md");
  writeFileSync(fixturePath, JSON.stringify(data));
  writeFileSync(summary, "");
  writeFileSync(mergePath, "null");
  writeFileSync(
    join(directory, "gh"),
    `#!/usr/bin/env node
const fs = require('node:fs');
const f = JSON.parse(fs.readFileSync(process.env.FIXTURE, 'utf8'));
const args = process.argv.slice(2);
const path = args.find(x => x.startsWith('repos/'));
let value;
if (path.endsWith('/merge')) {
  if (!args.includes('PUT')) throw Error('Unexpected write');
  fs.writeFileSync(process.env.MERGE, JSON.stringify(args));
  value = 'c'.repeat(40);
} else if (path.includes('/actions/workflows/ci.yml/runs?')) value = f.latest;
else if (path.endsWith('/actions/runs/42')) value = f.run;
else if (path.includes('/jobs?')) value = f.jobs;
else if (path.includes('/files?')) value = f.files;
else if (path.includes('/commits?')) value = f.commits;
else if (path.includes('/contents/package.json?')) value = path.endsWith(f.base) ? f.before : f.after;
else if (path.includes('/rules/branches/main?')) value = f.rules;
else if (path.endsWith('/branches/main')) value = f.base;
else if (path.endsWith('/pulls/8')) value = args.includes('--jq') ? f.pr.head.sha : f.pr;
else throw Error('Unexpected API request: ' + path);
process.stdout.write(typeof value === 'string' || typeof value === 'number' ? String(value) : JSON.stringify(value));
`,
    { mode: 0o700 },
  );
  const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", mergeScript], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      GH_TOKEN: "synthetic-test-token",
      FIXTURE: fixturePath,
      MERGE: mergePath,
      RUN_ID: "42",
      PR_NUMBER: "",
      DRY_RUN: String(dryRun),
      GITHUB_STEP_SUMMARY: summary,
    },
  });
  return {
    ...result,
    merge: JSON.parse(readFileSync(mergePath, "utf8")),
    summary: readFileSync(summary, "utf8"),
  };
};

describe("Dependabot policy in the actual CI workflow", () => {
  it.each([
    ["1.2.3", "1.2.4", true],
    ["1.2.3", "1.3.0", true],
    ["0.28.1", "0.28.2", true],
    ["0.28.2", "0.29.0", false],
    ["24.19.2", "26.6.5", false],
    ["1.2.3", "1.2.2", false],
    ["1.2.3", "1.3.0-rc.1", false],
    ["", "1.2.4", false],
  ])("classifies %s → %s", (prevVersion, newVersion, eligible) => {
    const directory = temporary();
    const output = join(directory, "output");
    const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", policyScript], {
      encoding: "utf8",
      env: {
        ...process.env,
        METADATA: JSON.stringify([
          {
            packageEcosystem: "npm_and_yarn",
            targetBranch: "main",
            maintainerChanges: false,
            prevVersion,
            newVersion,
          },
        ]),
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: join(directory, "summary"),
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(output, "utf8").trim()).toBe(`eligible=${eligible}`);
  });
});

describe("trusted Dependabot merge workflow", () => {
  it("merges only the checked revision and supports a read-only dry run", () => {
    const dry = executeMerge(fixture(), true);
    expect(dry.status, dry.stderr).toBe(0);
    expect(dry.merge).toBeNull();
    expect(dry.summary).toContain("eligible");
    const live = executeMerge(fixture());
    expect(live.status, live.stderr).toBe(0);
    expect(live.merge).toContain(`sha=${head}`);
    expect(live.merge).toContain("merge_method=squash");
  });

  it("holds major or missing eligibility without a write", () => {
    const data = fixture();
    data.jobs[0]?.jobs.splice(2);
    const result = executeMerge(data);
    expect(result.status, result.stderr).toBe(0);
    expect(result.merge).toBeNull();
    expect(result.summary).toContain("held");
  });

  it("rejects source/script edits, stale CI, spoofed authors and missing protection", () => {
    const cases = [
      (f: ReturnType<typeof fixture>) => {
        f.files[0]?.push({ filename: "src/index.ts", status: "modified" });
        f.pr.changed_files++;
      },
      (f: ReturnType<typeof fixture>) => {
        f.after.scripts.check = "echo bypass";
      },
      (f: ReturnType<typeof fixture>) => {
        f.after.dependencies.example = "https://example.invalid/evil.tgz";
      },
      (f: ReturnType<typeof fixture>) => {
        f.pr.user = { ...bot, id: 1234 };
      },
      (f: ReturnType<typeof fixture>) => {
        f.run.head_sha = base;
      },
      (f: ReturnType<typeof fixture>) => {
        f.latest = 43;
      },
      (f: ReturnType<typeof fixture>) => {
        f.rules = [[]];
      },
      (f: ReturnType<typeof fixture>) => {
        f.commits = [[]];
      },
      (f: ReturnType<typeof fixture>) => {
        f.pr.mergeable_state = "behind";
      },
    ];
    for (const mutate of cases) {
      const data = fixture();
      mutate(data);
      const result = executeMerge(data);
      expect(result.status).not.toBe(0);
      expect(result.merge).toBeNull();
    }
  });
});
