# Receipts

A receipt is a Git note (under `refs.notes`, default `refs/notes/panagent`) on each promoted
commit. It records what was verified, how, and by whom, in a form anyone can check against Git.

## Version 3

Schema: `schemas/receipt-v3.schema.json`.

| Field | Meaning |
|---|---|
| `schema` | `panagent.receipt.v3` |
| `generator` | Package name and version that wrote it |
| `workflow`, `run_id`, `task_id` | Which workflow and run produced the commit |
| `task_digest` | SHA-256 of the normalized task: scope, criteria, checks, repair limit |
| `promoted_head`, `tree`, `parents`, `base_commit` | The commit's identity; `base_commit` is the first parent |
| `candidate_digest` | `sha256({ base_commit, changed_files, diff })` of the verified candidate |
| `checks[]` | Each check's ID, `pass`, the digest of its definition (argv, cwd, timeout, dependencies, network, env), and the sandbox it ran in |
| `review` | `PASS` and the number of findings across the run |
| `repairs`, `agent_invocations`, `retries` | How much work it took |
| `runtimes` | Adapter, adapter version, provider, and model for each role |
| `config_digest` | The project config at the base commit |
| `runtime_config_digest` | The runtime config used |
| `policy_digest` | Prompts, tool definitions and limits, workflow definition, and package version |
| `governance` | Whether governance edits were allowed, by whom (Git identity), and why |

The digests let two results be compared honestly: same `policy_digest` and
`runtime_config_digest` means the same harness and runtimes produced them.

## Verification

`panagent receipt <commit>` and `land` check, in order:

1. the note parses and matches the schema (v3), or the legacy shape (v1, v2);
2. `promoted_head` is the commit, and `tree` and `parents` match the commit object;
3. `base_commit` is the first parent;
4. **the candidate digest recomputed from Git** (`git diff base..commit`) equals
   `candidate_digest`, so the note cannot claim a different change than the commit holds;
5. every check passed and the review decision is `PASS`.

## Landing

`panagent land <source> --target <branch>`:

- requires the target to be a first-parent ancestor of the source;
- verifies the receipt of every first-parent commit between them (integration commits carry their
  own receipt; the topic commits they merge are covered by it);
- fast-forwards the target with a compare-and-swap, or, if the target is checked out in a clean
  worktree, fast-forwards that worktree;
- never pushes.

## Legacy receipts

Versions 1 and 2 were written by the harness Panagent was extracted from. They verify with the
same commit checks and the same recomputed digest, so a repository that switches to Panagent and
keeps its batch prefix and notes ref can land across both histories.

## Limits

- Notes are not signed. Anyone with write access can add a note, and a forged note that matches
  the commit's real content and passes the schema would verify. Signing (SSH or Sigstore) and an
  in-toto envelope are planned.
- Notes do not travel with `git push` by default. Push the notes ref explicitly
  (`git push origin refs/notes/panagent`) if receipts should be shared.
