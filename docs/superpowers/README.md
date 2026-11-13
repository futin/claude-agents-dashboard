# docs/superpowers

What the brainstorm → plan → review loop leaves behind, and which of it stays in the tree.

| Directory    | Kept?                | Why                                                                                                                   |
| ------------ | -------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `specs/`     | yes                  | The _why_ behind the code: comments in `server/`, `client/`, `shared/`, `plugin/` and `test/` cite spec sections.      |
| `decisions/` | yes                  | Rulings and evaluations a live doc cites — today the context-mode evaluation `docs/overview.md` points at.            |
| `plans/`     | only while in flight | A plan is read by the session that executes it. Once its PR merges, the code, the spec and git history hold it.       |
| `reviews/`   | never (gitignored)   | doc-review, ui-verify and plan-review reports are spent once their findings are applied. Promote one to `decisions/` if a doc must cite it. |

## Reading what left

On 2026-11-13 every plan (39, all merged) and every review report (88) was pruned. The last commit that holds them is `85b39e0`:

```bash
git show 85b39e0:docs/superpowers/plans/2026-10-19-codegraph-view.md
git ls-tree --name-only 85b39e0 docs/superpowers/plans/ docs/superpowers/reviews/
```

or on GitHub: `https://github.com/futin/claude-agents-dashboard/blob/85b39e0/docs/superpowers/<dir>/<file>`. Links from kept files to pruned ones already point
there. `git log --diff-filter=D --name-only -- docs/superpowers` lists every later prune.

A few specs still mention a plan or review in backticks rather than as a link — records of their moment, read through the commands above.
