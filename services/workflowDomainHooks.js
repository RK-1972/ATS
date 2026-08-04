/**
 * Generic Workflow Engine → domain completion/reject notify bridge.
 * Workflow Engine calls this; domain modules own business reactions.
 * No Talent Demand / Budget logic lives in workflowService itself.
 */

const talentDemandWorkflowCompletionService = require("./talentDemandWorkflowCompletionService");
const budgetWorkflowCompletionService = require("./budgetWorkflowCompletionService");
const offerWorkflowCompletionService = require("./offerWorkflowCompletionService");

function parseContext(raw) {
  if (raw && typeof raw === "object") {
    return raw;
  }
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return {};
}

function isBudgetEvent(event = {}) {
  return budgetWorkflowCompletionService.isBudgetWorkflowEvent(event);
}

function isOfferEvent(event = {}) {
  return offerWorkflowCompletionService.isOfferWorkflowEvent(event);
}

/**
 * Intermediate approval step activated (Waiting → Pending).
 */
async function notifyApprovalStepActivated(queryable, event, req) {
  if (isBudgetEvent(event)) {
    return budgetWorkflowCompletionService.handleBudgetStepActivated(
      queryable,
      event,
      req
    );
  }

  const workflowCode = String(event.workflowCode || "").toUpperCase();
  if (workflowCode === "OFFER" || isOfferEvent(event)) {
    return offerWorkflowCompletionService.handleOfferStepActivated(
      queryable,
      event,
      req
    );
  }

  if (workflowCode === "REQUISITION") {
    return talentDemandWorkflowCompletionService.handleRequisitionStepActivated(
      queryable,
      event,
      req
    );
  }

  return {
    businessActionCompleted: false,
    reason: "No step-activated domain handler for this workflow"
  };
}

/**
 * Notify domain handlers that a workflow instance completed.
 */
async function notifyWorkflowCompleted(queryable, event, req) {
  const workflowCode = String(event.workflowCode || "").toUpperCase();

  if (workflowCode === "OFFER" || isOfferEvent(event)) {
    return offerWorkflowCompletionService.handleOfferWorkflowCompleted(
      queryable,
      event,
      req
    );
  }

  if (workflowCode === "REQUISITION" && isBudgetEvent(event)) {
    return budgetWorkflowCompletionService.handleBudgetWorkflowCompleted(
      queryable,
      event,
      req
    );
  }

  if (workflowCode === "REQUISITION") {
    return talentDemandWorkflowCompletionService.handleRequisitionWorkflowCompleted(
      queryable,
      event,
      req
    );
  }

  return {
    businessActionCompleted: false,
    reason: `No domain handler registered for workflow ${workflowCode || "(unknown)"}`
  };
}

/**
 * Notify domain handlers that a workflow instance was rejected/terminated.
 */
async function notifyWorkflowRejected(queryable, event, req) {
  const workflowCode = String(event.workflowCode || "").toUpperCase();

  if (workflowCode === "OFFER" || isOfferEvent(event)) {
    return offerWorkflowCompletionService.handleOfferWorkflowRejected(
      queryable,
      event,
      req
    );
  }

  if (workflowCode === "REQUISITION" && isBudgetEvent(event)) {
    return budgetWorkflowCompletionService.handleBudgetWorkflowRejected(
      queryable,
      event,
      req
    );
  }

  if (workflowCode === "REQUISITION") {
    return talentDemandWorkflowCompletionService.handleRequisitionWorkflowRejected(
      queryable,
      event,
      req
    );
  }

  return {
    businessActionCompleted: false,
    reason: `No domain reject handler registered for workflow ${workflowCode || "(unknown)"}`
  };
}

async function notifyClarificationRequested(queryable, event, req) {
  if (isBudgetEvent(event)) {
    return budgetWorkflowCompletionService.handleBudgetClarificationRequested(
      queryable,
      {
        ...event,
        executionContext: event.executionContext || parseContext(event.executionContext)
      },
      req
    );
  }

  const workflowCode = String(event.workflowCode || "").toUpperCase();
  if (workflowCode === "REQUISITION") {
    return talentDemandWorkflowCompletionService.handleRequisitionClarificationRequested(
      queryable,
      {
        ...event,
        executionContext: event.executionContext || parseContext(event.executionContext)
      },
      req
    );
  }

  return {
    businessActionCompleted: false,
    reason: "No clarification-requested domain handler for this workflow"
  };
}

async function notifyClarificationSubmitted(queryable, event, req) {
  if (isBudgetEvent(event)) {
    return budgetWorkflowCompletionService.handleBudgetClarificationSubmitted(
      queryable,
      event,
      req
    );
  }

  const workflowCode = String(event.workflowCode || "").toUpperCase();
  if (workflowCode === "REQUISITION") {
    return talentDemandWorkflowCompletionService.handleRequisitionClarificationSubmitted(
      queryable,
      event,
      req
    );
  }

  return {
    businessActionCompleted: false,
    reason: "No clarification-submitted domain handler for this workflow"
  };
}

module.exports = {
  notifyWorkflowCompleted,
  notifyWorkflowRejected,
  notifyApprovalStepActivated,
  notifyClarificationRequested,
  notifyClarificationSubmitted
};
