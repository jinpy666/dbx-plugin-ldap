# Agent workflow

This repository is the DBX LDAP plugin. Follow `.github/agent-flow.yml` as the machine-readable task contract.

## Handoff rules

- Use one branch/worktree per agent and never share a mutable checkout.
- Read the contract before editing and stay within `allowed_paths`.
- Keep version bumps, generated `ui/`, release metadata, and shared contract edits for the integrator.
- LDAP container tests must use generated throwaway credentials and local containers only; never use a real directory.
- Run local validation before handoff. The PR must list changed files, test results, risks, and follow-up work.
- Agents do not merge their own PRs.

## Integration rules

The integrator resolves shared-file conflicts, updates protocol/manifest consistency, regenerates outputs, and runs the complete container and packaging matrix.

