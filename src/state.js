import { loadTaskDag, saveTaskDagUnlocked, statuses, withTaskDagLock } from "./loader.js";
import { RuntimeError, TransitionError } from "./errors.js";
import { validateHandoff } from "./handoff.js";
import { getAssignmentEligibility } from "./scheduler.js";

export const allowedTransitions = {
  draft: ["ready"], ready: ["assigned"], assigned: ["in_progress", "blocked"], in_progress: ["handoff", "blocked"],
  handoff: ["review"], review: ["in_progress", "done"], done: [], blocked: ["ready"],
};

export async function updateTaskStatus(root, taskId, newStatus, options = {}) {
  return withTaskDagLock(root, async () => {
    const dag = await loadTaskDag(root);
    const task = dag.byId.get(taskId);
    if (!task) throw new RuntimeError(`Unknown task id: ${taskId}`, { code: "TASK_NOT_FOUND", details: { task_id: taskId } });
    const previousStatus = task.status;
    if (!statuses.has(newStatus) || !allowedTransitions[previousStatus].includes(newStatus)) {
      throw new TransitionError(`Illegal transition for '${taskId}': ${previousStatus} -> ${newStatus}`, {
        code: "TRANSITION_ILLEGAL",
        details: { task_id: taskId, from: previousStatus, to: newStatus },
      });
    }
    if (previousStatus === "ready" && newStatus === "assigned") assertEligible(dag, task);
    if (previousStatus === "handoff" && newStatus === "review") {
      if (task.handoff_required) {
        const validation = await validateHandoff(dag.root, task);
        if (!validation.valid) {
          throw new TransitionError(`Handoff validation failed for '${taskId}': ${validation.errors.join("; ")}`, {
            code: "HANDOFF_INVALID",
            details: validation.error_details,
          });
        }
        if (validation.delivery) task.raw.delivery_record = validation.delivery;
        task.raw.evidence_status = "current";
      } else if (task.delivery_kind || task.attempt > 1) {
        const summary = nonEmpty(options.validationEvidence);
        if (!summary) {
          throw new TransitionError(`Task '${task.id}' requires current validation evidence before review.`, {
            code: "VALIDATION_EVIDENCE_REQUIRED",
            details: { task_id: task.id, attempt: task.attempt },
          });
        }
        task.raw.validation_record = { attempt: task.attempt, summary };
        task.raw.evidence_status = "current";
      }
    }
    if (previousStatus === "review" && newStatus === "in_progress") recordRework(task, options.reason);
    if (previousStatus === "review" && newStatus === "done") {
      if ((task.delivery_kind || task.attempt > 1) && task.raw.evidence_status !== "current") {
        throw new TransitionError(`Task '${task.id}' has no current evidence for attempt ${task.attempt}.`, {
          code: "CURRENT_EVIDENCE_REQUIRED",
          details: { task_id: task.id, attempt: task.attempt },
        });
      }
      if (task.delivery_kind === "code") task.raw.integration_record = integrationRecord(task, options);
    }
    if (newStatus === "blocked") {
      task.raw.blocked_from = previousStatus;
      if (options.blocker) task.raw.blocker = options.blocker;
    }
    if (previousStatus === "blocked" && newStatus === "ready") delete task.raw.blocker;
    task.status = newStatus;
    task.raw.status = newStatus;
    task.raw.attempt = task.attempt;
    await saveTaskDagUnlocked(dag);
    return task;
  });
}

function assertEligible(dag, task) {
  const eligibility = getAssignmentEligibility(dag, task);
  if (!eligibility.eligible) {
    throw new TransitionError(`Task '${task.id}' is not eligible for assignment: ${eligibility.reasons.join("; ")}`, {
      code: "TASK_NOT_ELIGIBLE",
      details: { task_id: task.id, reasons: eligibility.reasons },
    });
  }
}

function recordRework(task, reason) {
  if (typeof reason !== "string" || !reason.trim()) {
    throw new TransitionError(`Task '${task.id}' requires a reason when review returns to in_progress.`, {
      code: "REWORK_REASON_REQUIRED",
      details: { task_id: task.id },
    });
  }
  if (task.raw.delivery_record) {
    task.raw.delivery_history = [...(task.raw.delivery_history ?? []), {
      ...task.raw.delivery_record,
      status: "superseded",
      reason: reason.trim(),
    }];
  }
  if (task.raw.validation_record) {
    task.raw.validation_history = [...(task.raw.validation_history ?? []), {
      ...task.raw.validation_record,
      status: "superseded",
      reason: reason.trim(),
    }];
  }
  task.attempt += 1;
  task.raw.attempt = task.attempt;
  task.raw.rework_reason = reason.trim();
  task.raw.evidence_status = "superseded";
  delete task.raw.delivery_record;
  delete task.raw.validation_record;
  delete task.raw.integration_record;
}

function integrationRecord(task, options) {
  const integrationCommit = nonEmpty(options.integrationCommit);
  const verificationCommit = nonEmpty(options.verificationCommit);
  const verification = nonEmpty(options.integrationVerification);
  if (!task.raw.delivery_record) {
    throw new TransitionError(`Code task '${task.id}' has no current delivery record.`, { code: "DELIVERY_RECORD_REQUIRED" });
  }
  if (!integrationCommit || !verificationCommit || !verification) {
    throw new TransitionError(`Code task '${task.id}' requires integration commit and verification metadata before done.`, {
      code: "INTEGRATION_EVIDENCE_REQUIRED",
      details: { required: ["integration_commit", "verification_commit", "integration_verification"] },
    });
  }
  if (!isCommitHash(integrationCommit) || !isCommitHash(verificationCommit)) {
    throw new TransitionError(`Integration commits for '${task.id}' must be complete immutable commit ids.`, {
      code: "INTEGRATION_COMMIT_INVALID",
      details: { integration_commit: integrationCommit, verification_commit: verificationCommit },
    });
  }
  if (integrationCommit !== verificationCommit) {
    throw new TransitionError(`Integration verification for '${task.id}' must target the final integration commit.`, {
      code: "INTEGRATION_VERSION_MISMATCH",
      details: { integration_commit: integrationCommit, verification_commit: verificationCommit },
    });
  }
  return {
    attempt: task.attempt,
    integration_commit: integrationCommit,
    verification_commit: verificationCommit,
    verification,
    delivery_head_commit: task.raw.delivery_record.head_commit,
  };
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isCommitHash(value) {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value);
}
