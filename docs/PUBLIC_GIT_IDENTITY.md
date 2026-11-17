# Public Git commit identity and immutable historical merge

The public source scanner normally rejects any commit whose author or
committer email is not a GitHub users.noreply.github.com address. It also
scans all historical blob/path pairs and commit messages for credentials,
private paths, personal email contents and invalid file names.

## One existing immutable GitHub merge

GitHub PR #31 merged as commit aae0f4c3be1c87763036f8643dfd8e169e08381a.
Its already-public author/committer metadata did not match the strict
noreply-only policy. Changing this existing SHA's metadata in place is
impossible. A force-rewrite of main alone does not guarantee removal of
GitHub's previously published PR refs, web views or downloaded copies.

The scanner therefore has one exact-hash historical metadata exception.
Only this immutable SHA is grandfathered, and only for the metadata test.
The complete commit message, tree, all historical paths and blobs are still
scanned. The exception does not allow a domain, a GitHub merge category or
another commit. Tests verify that a new non-noreply commit still fails.

This is a documented, narrow historical policy exception, NOT deletion of
prior email exposure. If stronger removal is required, plan a separate
coordinated repository history migration, assess PR refs, clones and
rollback, and verify what cannot be purged on GitHub. Never force-push main
as an ad hoc remedy.

## Future merges

Before publishing, require current-head reviews, finding disposition,
required CI and a clean source tree. All new commits must have noreply
author and committer metadata.

Until the GitHub account's merge identity settings are independently
verified, do not use an API-generated merge commit for this repository.
For a reviewed branch with a fast-forward ancestry, integrate the exact
reviewed commit via an ordinary non-force git merge --ff-only and push with
the existing local pre-push scanner intact. For a true merge commit, use
a separately reviewed local release process with both author and committer
noreply, requalify the changed head, and keep the scanning gate.

The policy must not be expanded to allow future personal email metadata.
If GitHub is reconfigured later, confirm actual commit metadata on a
disposable test branch before relying on its merge UI.

The exception and privacy-safe merge workflow are independent of
ContextKeep's application runtime or backup identity. Public source is not
a secret store and scanning does not replace repository access controls.
