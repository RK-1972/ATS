/**
 * Governed standard report definitions for Report Center.
 * V1.2 — semantic aggregate configuration with visualization metadata.
 */

const STANDARD_REPORTS = Object.freeze([
  {
    report_code: "CANDIDATE_PIPELINE",
    name: "Candidate Pipeline",
    description: "Candidates by current recruitment stage across active pipeline mappings.",
    category: "Pipeline",
    dataset_code: "CANDIDATE_PIPELINE",
    display_order: 10,
    icon: "pipeline",
    definition: {
      result_mode: "aggregate",
      dimensions: [{ field: "stage_name" }],
      measures: [
        {
          field: "candidate_id",
          aggregation: "COUNT_DISTINCT",
          alias: "candidate_count"
        }
      ],
      filters: [],
      sort: [{ field: "stage_name", direction: "asc" }],
      parameter_filters: [
        { field_code: "stage_name", label: "Pipeline Stage", default_operator: "equals" },
        { field_code: "department", label: "Department", default_operator: "equals" },
        {
          field_code: "assigned_recruiter_code",
          label: "Recruiter",
          default_operator: "equals"
        },
        { field_code: "requisition_code", label: "Requisition", default_operator: "equals" },
        { field_code: "applied_on", label: "Applied Date Range", default_operator: "between" }
      ]
    },
    visualization: {
      type: "bar",
      layout: "vertical",
      category_field: "stage_name",
      value_field: "candidate_count",
      title: "Candidates by Pipeline Stage",
      default_view: "visual"
    }
  },
  {
    report_code: "REQUISITION_OVERVIEW",
    name: "Requisition Overview",
    description: "Requisition portfolio breakdown by current status.",
    category: "Requisitions",
    dataset_code: "REQUISITION_SUMMARY",
    display_order: 20,
    icon: "requisitions",
    definition: {
      result_mode: "aggregate",
      dimensions: [{ field: "req_status" }],
      measures: [
        {
          field: "requisition_code",
          aggregation: "COUNT_DISTINCT",
          alias: "requisition_count"
        }
      ],
      filters: [],
      sort: [{ field: "req_status", direction: "asc" }],
      parameter_filters: [
        { field_code: "req_status", label: "Status", default_operator: "equals" },
        { field_code: "department", label: "Department", default_operator: "equals" },
        {
          field_code: "assigned_recruiter_code",
          label: "Recruiter",
          default_operator: "equals"
        },
        { field_code: "hiring_manager", label: "Hiring Manager", default_operator: "equals" }
      ]
    },
    visualization: {
      type: "column",
      layout: "vertical",
      category_field: "req_status",
      value_field: "requisition_count",
      title: "Requisitions by Status",
      default_view: "visual"
    }
  },
  {
    report_code: "HIRING_TREND",
    name: "Application Trend",
    description:
      "Candidate application activity over time using governed applied-on dates. This reflects applications, not completed hires.",
    category: "Trends",
    dataset_code: "CANDIDATE_PIPELINE",
    display_order: 30,
    icon: "trend",
    definition: {
      result_mode: "aggregate",
      dimensions: [{ field: "applied_on", grain: "MONTH" }],
      measures: [
        {
          field: "candidate_id",
          aggregation: "COUNT_DISTINCT",
          alias: "candidate_count"
        }
      ],
      filters: [],
      sort: [{ field: "applied_on__month", direction: "asc" }],
      parameter_filters: [
        { field_code: "applied_on", label: "Date Range", default_operator: "between" },
        { field_code: "department", label: "Department", default_operator: "equals" },
        {
          field_code: "assigned_recruiter_code",
          label: "Recruiter",
          default_operator: "equals"
        }
      ]
    },
    visualization: {
      type: "line",
      category_field: "applied_on__month",
      value_field: "candidate_count",
      title: "Applications Over Time",
      default_view: "visual"
    }
  },
  {
    report_code: "RECRUITMENT_FUNNEL",
    name: "Candidates by Pipeline Stage",
    description:
      "Distribution of candidates across current pipeline stages. Each mapping reflects one mutually exclusive current stage, not historical conversion.",
    category: "Pipeline",
    dataset_code: "CANDIDATE_PIPELINE",
    display_order: 40,
    icon: "funnel",
    definition: {
      result_mode: "aggregate",
      dimensions: [{ field: "stage_name" }],
      measures: [
        {
          field: "candidate_id",
          aggregation: "COUNT_DISTINCT",
          alias: "candidate_count"
        }
      ],
      filters: [],
      sort: [{ field: "stage_name", direction: "asc" }],
      parameter_filters: [
        { field_code: "stage_name", label: "Pipeline Stage", default_operator: "equals" },
        { field_code: "department", label: "Department", default_operator: "equals" },
        {
          field_code: "assigned_recruiter_code",
          label: "Recruiter",
          default_operator: "equals"
        },
        { field_code: "applied_on", label: "Applied Date Range", default_operator: "between" }
      ]
    },
    visualization: {
      type: "bar",
      layout: "vertical",
      category_field: "stage_name",
      value_field: "candidate_count",
      title: "Candidates by Pipeline Stage",
      default_view: "visual",
      stage_order: true
    }
  },
  {
    report_code: "RECRUITER_WORKLOAD",
    name: "Recruiter Workload",
    description: "Candidate pipeline distribution across assigned recruiters.",
    category: "Operations",
    dataset_code: "CANDIDATE_PIPELINE",
    display_order: 50,
    icon: "workload",
    definition: {
      result_mode: "aggregate",
      dimensions: [{ field: "assigned_recruiter_name" }],
      measures: [
        {
          field: "candidate_id",
          aggregation: "COUNT_DISTINCT",
          alias: "candidate_count"
        }
      ],
      filters: [],
      sort: [{ field: "candidate_count", direction: "desc" }],
      parameter_filters: [
        {
          field_code: "assigned_recruiter_code",
          label: "Recruiter",
          default_operator: "equals"
        },
        { field_code: "department", label: "Department", default_operator: "equals" },
        { field_code: "applied_on", label: "Applied Date Range", default_operator: "between" }
      ]
    },
    visualization: {
      type: "bar",
      layout: "horizontal",
      category_field: "assigned_recruiter_name",
      value_field: "candidate_count",
      title: "Candidates by Recruiter",
      default_view: "visual"
    }
  },
  {
    report_code: "DEPARTMENT_HIRING",
    name: "Requisitions by Department",
    description: "Requisition activity compared across departments.",
    category: "Workforce",
    dataset_code: "REQUISITION_SUMMARY",
    display_order: 60,
    icon: "department",
    definition: {
      result_mode: "aggregate",
      dimensions: [{ field: "department" }],
      measures: [
        {
          field: "requisition_code",
          aggregation: "COUNT_DISTINCT",
          alias: "requisition_count"
        }
      ],
      filters: [],
      sort: [{ field: "requisition_count", direction: "desc" }],
      parameter_filters: [
        { field_code: "department", label: "Department", default_operator: "equals" },
        { field_code: "req_status", label: "Status", default_operator: "equals" },
        {
          field_code: "assigned_recruiter_code",
          label: "Recruiter",
          default_operator: "equals"
        }
      ]
    },
    visualization: {
      type: "bar",
      layout: "horizontal",
      category_field: "department",
      value_field: "requisition_count",
      title: "Requisitions by Department",
      default_view: "visual"
    }
  }
]);

const REPORT_BY_CODE = new Map(
  STANDARD_REPORTS.map((report) => [report.report_code, report])
);

function listStandardReportDefinitions() {
  return STANDARD_REPORTS.slice().sort((a, b) => a.display_order - b.display_order);
}

function getStandardReportDefinition(reportCode) {
  return REPORT_BY_CODE.get(String(reportCode || "").trim()) || null;
}

function isStandardReportCode(reportCode) {
  return REPORT_BY_CODE.has(String(reportCode || "").trim());
}

module.exports = {
  listStandardReportDefinitions,
  getStandardReportDefinition,
  isStandardReportCode
};
