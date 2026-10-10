# Runbook

How to start, stop and reset the system and run scenarios. Updated whenever operations change.

## Prerequisites

- Node.js 26 (`nvm use` reads `.nvmrc`)
- pnpm 11 or newer installed globally; it switches itself to the version pinned in `package.json`
- Docker with Compose

## Check the workspace

```bash
pnpm install
pnpm verify
```

`pnpm install` also installs a git pre-commit hook (lefthook) that formats and lints the files you stage. To skip it for one commit in an emergency: `git commit --no-verify`. CI runs the same checks (from #4).

Start, stop and reset procedures are added with the Compose stack in #5.
