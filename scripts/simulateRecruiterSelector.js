/**
 * Simulates frontend selector path for Sachin with live backend bundle.
 * Run: node scripts/simulateRecruiterSelector.js
 */
require("dotenv").config();

const { Pool } = require("pg");
const recruitmentService = require("../services/recruitmentService");

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

function matchesRecruiter(user, assignment) {
  if (!user) return true;
  const employeeCode = user.employee_code || user.emp_code;
  const recruiterCode = assignment.recruiter_code || assignment.recruiter_id;
  if (!employeeCode || !recruiterCode) return true;
  return employeeCode === recruiterCode;
}

function buildRecruiterWorkspaceData({ user, recruitment, taskInbox, interviews, auditEvents, filter = "" }) {
  const assignments = recruitment?.recruiterAssignments || [];
  const requisitions = recruitment?.requisitions || [];
  const pipeline = recruitment?.pipeline || [];
  const tasks = taskInbox?.tasks || [];
  const interviewList = interviews?.interviews || interviews?.items || [];

  const myAssignmentCodes = assignments
    .filter((row) => row.is_active !== false && matchesRecruiter(user, row))
    .map((row) => row.requisition_code);

  const myRequisitions = requisitions.filter((req) => {
    if (!myAssignmentCodes.length) return true;
    return myAssignmentCodes.includes(req.requisition_code);
  });

  const myRequisitionCodes = new Set(myRequisitions.map((req) => req.requisition_code));

  const myPipeline = pipeline.filter((row) => {
    if (!myRequisitionCodes.size) return true;
    return myRequisitionCodes.has(row.requisition_code);
  });

  const today = new Date().toISOString().slice(0, 10);
  const interviewsToday = interviewList.filter((row) => {
    const onMyReq = !myRequisitionCodes.size || myRequisitionCodes.has(row.requisition_code);
    return onMyReq && row.interview_date === today;
  });

  const recruiterTasks = tasks.filter((task) => {
    const roleMatch = /recruiter/i.test(task.assignee_role || "");
    const moduleMatch = /recruitment|interview/i.test(task.module || "");
    const assigneeMatch = user?.name ? task.assignee === user.name : true;
    return (roleMatch || moduleMatch) && assigneeMatch && task.status === "Pending";
  });

  return {
    storeInput: {
      assignments: assignments.length,
      requisitions: requisitions.length,
      pipeline: pipeline.length,
      tasks: tasks.length,
      interviews: interviewList.length
    },
    filterSteps: {
      myAssignmentCodes,
      myAssignmentCodesCount: myAssignmentCodes.length,
      myRequisitionsCount: myRequisitions.length,
      myPipelineCount: myPipeline.length,
      interviewsTodayCount: interviewsToday.length,
      recruiterTasksCount: recruiterTasks.length
    },
    kpis: {
      requisitions: myRequisitions.length,
      candidates: myPipeline.length,
      interviewsToday: interviewsToday.length,
      tasks: recruiterTasks.length
    }
  };
}

async function main() {
  const sachinUser = {
    user_id: 10,
    employee_code: "IGS0506",
    full_name: "Schin S",
    role_name: "Recruiter",
    email_id: "sachin.s@igsglobal.com"
  };

  console.log("=== SIMULATION: Empty store (mock mode / API failure) ===");
  console.log(JSON.stringify(buildRecruiterWorkspaceData({
    user: sachinUser,
    recruitment: { requisitions: [], recruiterAssignments: [], pipeline: [] },
    taskInbox: { tasks: [] },
    interviews: { interviews: [] }
  }), null, 2));

  const bundle = await recruitmentService.getRecruitmentBundle(pool);
  const taskService = require("../services/taskService");
  const interviewService = require("../services/interviewService");
  const taskBundle = await taskService.getTaskBundle(pool);
  const interviewBundle = await interviewService.getInterviewBundle(pool);

  console.log("\n=== SIMULATION: Full live backend data for Sachin ===");
  console.log(JSON.stringify(buildRecruiterWorkspaceData({
    user: sachinUser,
    recruitment: bundle,
    taskInbox: taskBundle,
    interviews: interviewBundle
  }), null, 2));

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  await pool.end();
  process.exit(1);
});
