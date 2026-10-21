# Contributing

Use issues for reproducible bugs and feature discussions. For suspected security
vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Development

Use Node.js 24 and the pnpm version pinned in `package.json`. Fork the repository
if you do not have write access, then create a branch from `main`.

```sh
corepack enable
pnpm install --frozen-lockfile --ignore-scripts
pnpm lint
pnpm typecheck
pnpm build
```

CI also runs `npm pack --ignore-scripts` to verify package generation. Dependencies
are installed without lifecycle scripts. Any change that needs an install script
must explain why and narrowly scope the additional execution.

The current main branch has no automated runtime test suite. Lint, type checks,
builds, and packaging do not prove runtime correctness. Include reproduction or
manual verification steps for behavior changes; add regression tests when adding
a test harness.

## Pull requests

- Keep each PR focused and explain the problem, behavior change, and validation.
- Update the lockfile with pnpm when changing dependencies; do not hand-edit it.
- Do not include `node_modules`, generated `dist` output, credentials, or private data.
- Address review conversations and bring the branch up to date with `main`.
- Wait for the `Quality` check, then a maintainer can squash-merge the PR.

All changes to `main`, including maintainer changes, go through a PR. Direct
changes, force pushes, and deletion of `main` are blocked by the repository
ruleset. Only maintainers have merge access. There is currently one maintainer,
so a separate approving review is not required; this does not grant contributors
merge access. `CODEOWNERS` requests maintainer review when applicable.

Workflows from external contributors require maintainer approval before they
run. Approval to run CI is separate from accepting the code. PR CI uses a
read-only token, GitHub-hosted runners, and no publishing credentials. Changes
to workflows and dependencies receive particular attention during review.

See [.github/MAINTAINING.md](.github/MAINTAINING.md) for repository administration
and the release procedure.
