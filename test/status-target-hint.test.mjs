// @ts-check
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { planGc } from "../src/core/gc.mjs";
import { repositoryStatus } from "../src/core/status.mjs";
import { HarnessError } from "../src/util/errors.mjs";
import { git } from "../src/util/git.mjs";
import { makeRepo, testTempDir } from "./helpers.mjs";

for (const [command, inspect] of [
  ["status", repositoryStatus],
  ["gc", planGc],
]) {
  test(`${command} hints at the main worktree target and accepts a configured linked target`, (t) => {
    const repo = makeRepo();
    t.after(repo.cleanup);
    const linked = path.join(testTempDir("target-hint"), "tree");
    git(repo.root, ["branch", "-m", "data"]);
    git(repo.root, ["worktree", "add", "-qb", "configured", linked]);
    git(repo.root, ["rm", "apocha.config.json"]);
    git(repo.root, ["commit", "-qm", "data branch without config"]);
    git(repo.root, ["branch", "unconfigured"]);

    assert.throws(
      () => inspect(repo.root),
      (error) => {
        assert.ok(error instanceof HarnessError);
        assert.equal(error.code, "missing_project_config");
        assert.match(error.message, /apocha\.config\.json not found on data/);
        assert.match(error.message, /the default target is the branch checked out in the main worktree/);
        assert.match(error.message, /pass --target <branch> for a configured branch/);
        assert.match(error.message, /or run 'apocha init' if this repository has no Apocha config/);
        if (command === "gc") assert.ok(error.message.includes(repo.root));
        return true;
      },
    );

    const result = inspect(linked, { target: "configured" });
    assert.equal(typeof result.target === "string" ? result.target : result.target.branch, "configured");

    assert.throws(
      () => inspect(repo.root, { target: "unconfigured" }),
      (error) => {
        assert.ok(error instanceof HarnessError);
        assert.equal(error.code, "missing_project_config");
        assert.match(error.message, /apocha\.config\.json not found on unconfigured/);
        assert.match(error.message, /pass --target/);
        assert.doesNotMatch(error.message, /default/);
        return true;
      },
    );

    if (command === "status") {
      assert.throws(() => repositoryStatus(linked), /not found on data.*default target.*--target/);
    } else {
      // GC continues reading config from the calling working tree.
      assert.equal(planGc(linked).target, "data");
    }
  });
}
