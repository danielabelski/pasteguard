@AGENTS.md

# Fork workflow

- `master` is the stable working branch used by the local stack.
- `main` is reserved for mirroring `upstream/main`.
- Do not propose or create pull requests to the original upstream project.
- Keep custom work in `master`; absorb upstream updates through short-lived sync branches with verification before merging back into `master`.

## Sync procedure

1. Update upstream refs: `git fetch upstream origin`
2. Refresh local `main` from upstream: `git checkout main && git reset --hard upstream/main`
3. Push refreshed `main` to fork if needed: `git push origin main`
4. Create a temporary sync branch from current `master`: `git checkout master && git checkout -b sync/<date-or-topic>`
5. Merge or rebase the refreshed `main` into the sync branch.
6. Run verification before touching `master`:
   - `bun test`
   - `bun run typecheck`
   - `bun run check`
   - local runtime/manual smoke check if the stack integration changed
7. Only after verification succeeds, merge the sync branch back into `master`.
8. Delete the temporary sync branch after merge.

## Safety rules

- `master` should stay deployable/runnable.
- If upstream integration breaks tests or runtime behavior, keep the breakage isolated in the sync branch and do not merge it into `master`.
- Use `main` only as the upstream mirror, not as the place for custom work.
- If a sync requires conflict resolution, resolve it in the sync branch and re-run the full verification set.

## Default remote roles

- `origin` = user's fork (`danielabelski/pasteguard`)
- `upstream` = original project (`sgasser/pasteguard`)

## Typical commands

```bash
git fetch upstream origin
git checkout main
git reset --hard upstream/main
git push origin main
git checkout master
git checkout -b sync/<date-or-topic>
git merge main
bun test
bun run typecheck
bun run check
# if green
git checkout master
git merge sync/<date-or-topic>
git branch -d sync/<date-or-topic>
```

## Notes

- Prefer merge-based sync into `master` unless there is a specific reason to rebase.
- The temporary sync branch is the safety buffer where upstream changes are tested before they affect the working branch.

