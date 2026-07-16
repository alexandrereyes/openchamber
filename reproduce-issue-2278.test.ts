/**
 * Reproduction script for issue #2278:
 * "pr-review runs before pr checks complete — should wait for successful checks"
 *
 * This script verifies that oc-review.yml (pr checks) and pr-review.yml
 * trigger on the same pull_request events simultaneously with no dependency.
 */

import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { parse } from "yaml";

describe("Issue #2278: pr-review runs before pr checks", () => {
  const ocReview = parse(readFileSync(".github/workflows/oc-review.yml", "utf-8"));
  const prReview = parse(readFileSync(".github/workflows/pr-review.yml", "utf-8"));

  it("oc-review.yml is named 'pr checks'", () => {
    expect(ocReview.name).toBe("pr checks");
  });

  it("oc-review.yml triggers on pull_request events", () => {
    expect(ocReview.on.pull_request).toBeDefined();
    expect(ocReview.on.pull_request.types).toContain("opened");
    expect(ocReview.on.pull_request.types).toContain("synchronize");
    expect(ocReview.on.pull_request.types).toContain("reopened");
    expect(ocReview.on.pull_request.types).toContain("ready_for_review");
  });

  it("pr-review.yml triggers on pull_request_target events matching oc-review events", () => {
    expect(prReview.on.pull_request_target).toBeDefined();
    expect(prReview.on.pull_request_target.types).toContain("opened");
    expect(prReview.on.pull_request_target.types).toContain("synchronize");
    expect(prReview.on.pull_request_target.types).toContain("reopened");
    expect(prReview.on.pull_request_target.types).toContain("ready_for_review");
  });

  it("pr-review.yml triggers on the same PR events as oc-review.yml — confirming concurrent execution", () => {
    // This is the core of the bug: both workflows fire on identical events
    const ocEvents = new Set(ocReview.on.pull_request.types);
    const prEvents = new Set(prReview.on.pull_request_target.types);

    // All oc-review events are also pr-review events
    const overlapping = [...ocEvents].filter((e) => prEvents.has(e));
    expect(overlapping.sort()).toEqual(["opened", "ready_for_review", "reopened", "synchronize"]);

    // Therefore they run simultaneously on every PR event
  });

  it("pr-review.yml has no 'needs' dependency on oc-review.yml's 'pr checks' workflow", () => {
    // Check that pr-review.yml does not reference oc-review.yml's job
    const content = readFileSync(".github/workflows/pr-review.yml", "utf-8");
    expect(content).not.toContain("needs:");
    // No workflow_run trigger referencing "pr checks"
    expect(content).not.toContain("workflow_run");
    expect(content).not.toContain("pr checks");
  });

  it("oc-review.yml has no 'needs' dependency on pr-review.yml", () => {
    const content = readFileSync(".github/workflows/oc-review.yml", "utf-8");
    expect(content).not.toContain("needs:");
    expect(content).not.toContain("workflow_run");
    expect(content).not.toContain("pr-review");
  });

  it("CONFIRMED BUG: Both workflows have no ordering constraints between them", () => {
    // Final assertion: no dependency mechanism exists between these two workflows
    const ocContent = readFileSync(".github/workflows/oc-review.yml", "utf-8");
    const prContent = readFileSync(".github/workflows/pr-review.yml", "utf-8");

    const hasNeedsDependency =
      ocContent.includes("needs:") || prContent.includes("needs:");
    const hasWorkflowRun =
      ocContent.includes("workflow_run") || prContent.includes("workflow_run");

    expect(hasNeedsDependency || hasWorkflowRun).toBe(false);
    // No workflow_run trigger, no needs dependency => they run concurrently
    expect(true).toBe(true); // Mark the test as implicitly confirming the bug
  });
});
