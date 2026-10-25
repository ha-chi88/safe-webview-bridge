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
const mergeScript = step(
  ".github/workflows/renovate-automerge.yml",
  "Merge a verified dependency or toolchain update",
);
const head = "a".repeat(40);
const base = "b".repeat(40);
const repository = { id: 123, full_name: "ha-chi88/safe-webview-bridge" };
const bot = { id: 347749962, login: "groove08-renovate[bot]", type: "Bot" };
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
    head: { sha: head, ref: "renovate/example-1.2.4", repo: repository },
    base: { sha: base, ref: "main", repo: repository },
    changed_files: 2,
    commits: 1,
    mergeable: true,
    mergeable_state: "clean",
  },
  jobs: [
    {
      jobs: ["Quality", "Infrastructure security"].map((name) => ({
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
    packageManager: "pnpm@10.6.2",
    scripts: { check: "vitest" },
    dependencies: { example: "^1.2.3" },
    devDependencies: {},
  },
  after: {
    name: "safe-webview-bridge",
    packageManager: "pnpm@10.6.2",
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
          required_status_checks: ["Quality", "Infrastructure security"].map(
            (context) => ({ context, integration_id: 15368 }),
          ),
        },
      },
    ],
  ],
  latest: 42,
  base,
  release: {
    tag_name: "v12.14.0",
    draft: false,
    prerelease: false,
    published_at: "2020-01-01T00:00:00Z",
  },
  advisories: { reviewed: [[]], malware: [[]], unreviewed: [[]] } as Record<
    string,
    unknown
  >,
  workflows: {} as Record<string, { before: string; after: string }>,
  failRoute: "",
});

const pnpmFixture = () => {
  const data = fixture();
  data.after = structuredClone(data.before);
  data.after.packageManager = "pnpm@12.14.0";
  return data;
};
const runnerFixture = () => {
  const data = fixture();
  const paths = [
    ".github/workflows/ci.yml",
    ".github/workflows/publish.yml",
    ".github/workflows/renovate-automerge.yml",
  ];
  data.pr.changed_files = paths.length;
  data.files = [paths.map((filename) => ({ filename, status: "modified" }))];
  for (const path of paths) {
    const before = readFileSync(path, "utf8").replace(
      /^    runs-on: ubuntu-(?:22|24|26)\.04$/gm,
      "    runs-on: ubuntu-24.04",
    );
    data.workflows[path] = {
      before,
      after: before.replace(
        /^    runs-on: ubuntu-24\.04$/gm,
        "    runs-on: ubuntu-26.04",
      ),
    };
  }
  return data;
};

const executeMerge = (data: ReturnType<typeof fixture>, dryRun = false) => {
  const directory = temporary();
  const fixturePath = join(directory, "fixture.json");
  const mergePath = join(directory, "merge.json");
  const summary = join(directory, "summary.md");
  const requestsPath = join(directory, "requests.json");
  writeFileSync(fixturePath, JSON.stringify(data));
  writeFileSync(summary, "");
  writeFileSync(mergePath, "null");
  writeFileSync(requestsPath, "[]");
  writeFileSync(
    join(directory, "gh"),
    `#!/usr/bin/env node
const fs = require('node:fs');
const f = JSON.parse(fs.readFileSync(process.env.FIXTURE, 'utf8'));
const args = process.argv.slice(2);
const path = args.find(x => x.startsWith('repos/') || x.startsWith('advisories?'));
const requests = JSON.parse(fs.readFileSync(process.env.REQUESTS, 'utf8'));
fs.writeFileSync(process.env.REQUESTS, JSON.stringify([...requests, path]));
if (f.failRoute && path.includes(f.failRoute)) throw Error('Simulated API failure');
let value;
if (path.startsWith('repos/pnpm/pnpm/releases/')) value = f.release;
else if (path.startsWith('advisories?')) value = f.advisories[new URLSearchParams(path.split('?')[1]).get('type')];
else if (path.includes('/contents/.github/workflows/')) {
  const name = path.split('/contents/')[1].split('?')[0];
  const content = f.workflows[name][path.endsWith(f.base) ? 'before' : 'after'];
  value = { type: 'file', encoding: 'base64', size: Buffer.byteLength(content), content: Buffer.from(content).toString('base64') };
} else if (path.endsWith('/merge')) {
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
      REQUESTS: requestsPath,
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
    requests: JSON.parse(readFileSync(requestsPath, "utf8")) as string[],
  };
};

const expectHeld = (data: ReturnType<typeof fixture>) => {
  const result = executeMerge(data);
  expect(result.merge).toBeNull();
  expect(result.status !== 0 || result.summary.includes("held:")).toBe(true);
};

describe("verified pnpm updates", () => {
  it.each(["10.34.7", "12.14.0"])("allows stable pnpm %s", (version) => {
    const data = pnpmFixture();
    data.after.packageManager = `pnpm@${version}`;
    data.release.tag_name = `v${version}`;
    const result = executeMerge(data);
    expect(result.status, result.stderr).toBe(0);
    expect(result.merge).toContain(`sha=${head}`);
    expect(result.summary).toContain("pnpm eligibility");
    for (const type of ["reviewed", "malware", "unreviewed"])
      expect(result.requests).toContain(
        `advisories?ecosystem=npm&affects=pnpm%40${version}&type=${type}&is_withdrawn=false&per_page=100`,
      );
  });

  it.each([
    "pnpm@10.6.2",
    "pnpm@9.0.0",
    "pnpm@13.0.0-rc.1",
    "pnpm@latest",
    "pnpm@^12.14.0",
    "pnpm@012.14.0",
    "npm@12.14.0",
    "https://example.invalid/pnpm.tgz",
  ])("holds unsupported package manager %s", (value) => {
    const data = pnpmFixture();
    data.after.packageManager = value;
    expectHeld(data);
  });

  it("holds mixed dependency, script and policy edits", () => {
    for (const change of [
      { dependencies: { example: "^2.0.0" } },
      { scripts: { check: "echo bypass" } },
      { pnpm: { dangerouslyAllowAllBuilds: true } },
    ]) {
      const data = pnpmFixture();
      Object.assign(data.after, change);
      expectHeld(data);
    }
  });

  it.each([
    { published_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z") },
    { published_at: "2099-01-01T00:00:00Z" },
    { published_at: "invalid" },
    { prerelease: true },
    { draft: true },
    { tag_name: "v99.0.0" },
  ])("holds unqualified official release %j", (release) => {
    const data = pnpmFixture();
    Object.assign(data.release, release);
    expectHeld(data);
  });

  it.each(["reviewed", "malware", "unreviewed"])(
    "holds active %s advisories, including later pages",
    (type) => {
      const data = pnpmFixture();
      data.advisories[type] = [[], [{ ghsa_id: "GHSA-test" }]];
      expectHeld(data);
    },
  );

  it.each([[], {}, null, { message: "unavailable" }])(
    "rejects missing or malformed advisory responses %j",
    (response) => {
      const data = pnpmFixture();
      data.advisories.reviewed = response;
      expectHeld(data);
    },
  );

  it.each(["releases/", "advisories?"])("fails closed if %s cannot be read", (route) => {
    const data = pnpmFixture();
    data.failRoute = route;
    expectHeld(data);
  });
});

describe("verified Ubuntu runner updates", () => {
  it("allows only runner version changes in all three trusted workflows", () => {
    const data = runnerFixture();
    const result = executeMerge(data);
    expect(result.status, result.stderr).toBe(0);
    expect(result.merge).toContain(`sha=${head}`);
    expect(result.summary).toContain("ubuntu-runners eligibility");
    for (const file of Object.keys(data.workflows))
      for (const ref of [head, base])
        expect(result.requests).toContain(
          `repos/ha-chi88/safe-webview-bridge/contents/${file}?ref=${ref}`,
        );
  });

  it.each([
    "ubuntu-latest",
    "ubuntu-28.04",
    "ubuntu-22.04",
    "self-hosted",
    "[self-hosted, ubuntu-26.04]",
    "${{ matrix.runner }}",
  ])("holds unapproved runner %s", (runner) => {
    const data = runnerFixture();
    data.workflows[".github/workflows/ci.yml"]!.after = data.workflows[
      ".github/workflows/ci.yml"
    ]!.after.replace(/^    runs-on: ubuntu-26\.04$/gm, `    runs-on: ${runner}`);
    expectHeld(data);
  });

  it("holds any additional workflow change, including the merge policy itself", () => {
    for (const file of Object.keys(runnerFixture().workflows)) {
      const data = runnerFixture();
      data.workflows[file]!.after += "\n# unrelated change\n";
      expectHeld(data);
    }
    const data = runnerFixture();
    const workflow = data.workflows[".github/workflows/ci.yml"]!;
    workflow.after = workflow.after.replace("contents: read", "contents: write");
    expectHeld(data);
  });

  it("rejects workflow additions, mixed files, incomplete evidence and API errors", () => {
    for (const change of [
      (data: ReturnType<typeof fixture>) => {
        data.files[0]![0]!.status = "added";
      },
      (data: ReturnType<typeof fixture>) => {
        data.files[0]![0]!.filename = "package.json";
      },
      (data: ReturnType<typeof fixture>) => {
        data.files[0]![0]!.filename = ".github/workflows/evil.yml";
      },
      (data: ReturnType<typeof fixture>) => {
        data.pr.changed_files++;
      },
      (data: ReturnType<typeof fixture>) => {
        data.failRoute = "/contents/.github/";
      },
    ]) {
      const data = runnerFixture();
      change(data);
      expectHeld(data);
    }
  });
});

describe.each([pnpmFixture, runnerFixture])("toolchain trust gates", (makeFixture) => {
  it("never writes during a dry run", () => {
    const result = executeMerge(makeFixture(), true);
    expect(result.status, result.stderr).toBe(0);
    expect(result.merge).toBeNull();
    expect(result.summary).toContain("eligible");
  });

  it("still requires fresh CI, bot signatures and branch protection", () => {
    for (const change of [
      (data: ReturnType<typeof fixture>) => {
        data.jobs[0]!.jobs[0]!.conclusion = "failure";
      },
      (data: ReturnType<typeof fixture>) => {
        data.run.pull_requests[0]!.base.sha = "d".repeat(40);
      },
      (data: ReturnType<typeof fixture>) => {
        data.commits[0]![0]!.commit.verification.verified = false;
      },
      (data: ReturnType<typeof fixture>) => {
        data.pr.user = { ...bot, id: 1 };
      },
      (data: ReturnType<typeof fixture>) => {
        data.rules = [[]];
      },
    ]) {
      const data = makeFixture();
      change(data);
      expectHeld(data);
    }
  });
});

describe("Stable forward dependency policy in the trusted merge workflow", () => {
  it.each([
    ["1.2.3", "1.2.4", true],
    ["1.2.3", "1.3.0", true],
    ["0.28.1", "0.28.2", true],
    ["0.28.2", "0.29.0", true],
    ["24.19.2", "26.6.5", true],
    ["0.99.99", "1.0.0", true],
    ["1.99.99", "2.0.0", true],
    ["2.0.0", "1.99.99", false],
    ["0.29.0", "0.28.99", false],
    ["1.2.3", "1.2.2", false],
    ["1.2.3", "1.3.0-rc.1", false],
    ["", "1.2.4", false],
  ])("classifies %s → %s", (prevVersion, newVersion, eligible) => {
    const data = fixture();
    data.before.dependencies.example = prevVersion;
    data.after.dependencies.example = newVersion;
    const result = executeMerge(data);
    expect(result.status, result.stderr).toBe(0);
    expect(result.merge !== null).toBe(eligible);
    if (!eligible) expect(result.summary).toContain("held:");
  });
});

describe("trusted Renovate merge workflow", () => {
  it.each(["^1.2.4", "^2.0.0"])(
    "merges checked %s and supports a read-only dry run",
    (version) => {
      const data = fixture();
      data.after.dependencies.example = version;
      const dry = executeMerge(data, true);
      expect(dry.status, dry.stderr).toBe(0);
      expect(dry.merge).toBeNull();
      expect(dry.summary).toContain("eligible");
      const live = executeMerge(data);
      expect(live.status, live.stderr).toBe(0);
      expect(live.merge).toContain(`sha=${head}`);
      expect(live.merge).toContain("merge_method=squash");
    },
  );

  it.each(["Quality", "Infrastructure security"])(
    "holds a major when %s has not succeeded",
    (name) => {
      const data = fixture();
      data.after.dependencies.example = "^2.0.0";
      for (const group of data.jobs)
        group.jobs = group.jobs.filter((job) => job.name !== name);
      const result = executeMerge(data);
      expect(result.status, result.stderr).toBe(0);
      expect(result.merge).toBeNull();
      expect(result.summary).toContain("held");
    },
  );

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
        Object.assign(f.before, { packageManager: "pnpm@10.6.2" });
        Object.assign(f.after, { packageManager: "pnpm@10.34.7" });
      },
      (f: ReturnType<typeof fixture>) => {
        f.after.dependencies.example = "https://example.invalid/evil.tgz";
      },
      (f: ReturnType<typeof fixture>) => {
        f.pr.user = { ...bot, id: 1234 };
      },
      (f: ReturnType<typeof fixture>) => {
        f.pr.user = { id: 49699333, login: "dependabot[bot]", type: "Bot" };
      },
      (f: ReturnType<typeof fixture>) => {
        f.after.dependencies.example = "~1.2.4";
      },
      (f: ReturnType<typeof fixture>) => {
        f.after.dependencies.example = "^1.2.3";
      },
      (f: ReturnType<typeof fixture>) => {
        f.commits[0]![0]!.commit.verification.verified = false;
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
      expect(result.merge).toBeNull();
      // A normal review hold can complete successfully, but must explain that
      // no merge was authorized. Identity/CI/protection failures still fail closed.
      expect(result.status !== 0 || result.summary.includes("held:")).toBe(true);
    }
  }, 20_000);
});
