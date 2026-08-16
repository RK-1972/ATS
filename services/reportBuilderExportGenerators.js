const ExcelJS = require("exceljs");
const { generatePdfExport } = require("./reportBuilderPdfExport");

const {
  formatExportCellValue,
  formatExportGeneratedTimestamp,
  buildExportFilename
} = require("../utils/reportExportFormatters");

const OPTALYNX_BLUE = "#1f3b63";
const OPTALYNX_ORANGE = "#f39c12";

function formatFilterSummary(filters = []) {
  if (!filters.length) {
    return "None";
  }

  return filters
    .map((filter) => {
      const label = filter.field?.label || filter.field?.code || "Field";
      const operator = String(filter.operator || "equals").replace(/_/g, " ");
      const value = Array.isArray(filter.value)
        ? filter.value.join(", ")
        : String(filter.value ?? "");
      return `${label} ${operator} ${value}`;
    })
    .join("; ");
}

function mapRowsForExport(columns, rows) {
  return rows.map((row) => {
    const mapped = {};

    for (const column of columns) {
      mapped[column.code] = formatExportCellValue(row[column.code], column.data_type);
    }

    return mapped;
  });
}

async function generateXlsxExport(exportContext) {
  const { dataset, columns, rows, filters } = exportContext;
  const workbook = new ExcelJS.Workbook();
  const worksheetName = String(dataset.name || "Report").slice(0, 31);
  const worksheet = workbook.addWorksheet(worksheetName || "Report");

  worksheet.mergeCells(1, 1, 1, Math.max(columns.length, 1));
  worksheet.getCell(1, 1).value = "OPTALYNX — Report Builder";
  worksheet.getCell(1, 1).font = { bold: true, size: 14, color: { argb: "FF1F3B63" } };

  worksheet.mergeCells(2, 1, 2, Math.max(columns.length, 1));
  worksheet.getCell(2, 1).value = dataset.name;
  worksheet.getCell(2, 1).font = { bold: true, size: 12 };

  worksheet.mergeCells(3, 1, 3, Math.max(columns.length, 1));
  worksheet.getCell(3, 1).value = `Generated: ${formatExportGeneratedTimestamp()}`;
  worksheet.getCell(3, 1).font = { size: 10, color: { argb: "FF666666" } };

  worksheet.mergeCells(4, 1, 4, Math.max(columns.length, 1));
  worksheet.getCell(4, 1).value = `Filters: ${formatFilterSummary(filters)}`;
  worksheet.getCell(4, 1).font = { size: 10, color: { argb: "FF666666" } };

  const headerRowIndex = 6;
  const headerRow = worksheet.getRow(headerRowIndex);
  columns.forEach((column, index) => {
    const cell = headerRow.getCell(index + 1);
    cell.value = column.label;
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF1F3B63" }
    };
    cell.alignment = { vertical: "middle", horizontal: "left" };
    cell.border = {
      top: { style: "thin", color: { argb: "FFD0D7E2" } },
      left: { style: "thin", color: { argb: "FFD0D7E2" } },
      bottom: { style: "thin", color: { argb: "FFD0D7E2" } },
      right: { style: "thin", color: { argb: "FFD0D7E2" } }
    };
  });
  headerRow.height = 20;

  const formattedRows = mapRowsForExport(columns, rows);
  formattedRows.forEach((row, rowIndex) => {
    const excelRow = worksheet.getRow(headerRowIndex + 1 + rowIndex);
    columns.forEach((column, columnIndex) => {
      const cell = excelRow.getCell(columnIndex + 1);
      const rawValue = row[column.code];
      cell.value = rawValue;
      cell.alignment = { vertical: "top", wrapText: true };
      cell.border = {
        top: { style: "thin", color: { argb: "FFE5E7EB" } },
        left: { style: "thin", color: { argb: "FFE5E7EB" } },
        bottom: { style: "thin", color: { argb: "FFE5E7EB" } },
        right: { style: "thin", color: { argb: "FFE5E7EB" } }
      };

      if (column.data_type === "number" && rawValue !== "") {
        const numericValue = Number(String(rawValue).replace(/,/g, ""));
        if (Number.isFinite(numericValue)) {
          cell.value = numericValue;
          cell.numFmt = "#,##0.##";
        }
      }
    });
  });

  worksheet.columns = columns.map((column) => ({
    key: column.code,
    width: Math.min(Math.max(String(column.label || column.code).length + 4, 14), 40)
  }));

  worksheet.views = [{ state: "frozen", ySplit: headerRowIndex }];
  worksheet.autoFilter = {
    from: { row: headerRowIndex, column: 1 },
    to: { row: headerRowIndex, column: Math.max(columns.length, 1) }
  };

  const buffer = await workbook.xlsx.writeBuffer();
  return {
    buffer: Buffer.from(buffer),
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    filename: buildExportFilename(dataset.code, "xlsx")
  };
}

function escapeCsvValue(value) {
  const text = value === null || value === undefined ? "" : String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function generateCsvExport(exportContext) {
  const { dataset, columns, rows } = exportContext;
  const formattedRows = mapRowsForExport(columns, rows);
  const lines = [];

  lines.push(columns.map((column) => escapeCsvValue(column.label)).join(","));

  for (const row of formattedRows) {
    lines.push(columns.map((column) => escapeCsvValue(row[column.code])).join(","));
  }

  const csvBody = `\uFEFF${lines.join("\r\n")}`;
  return {
    buffer: Buffer.from(csvBody, "utf8"),
    contentType: "text/csv; charset=utf-8",
    filename: buildExportFilename(dataset.code, "csv")
  };
}

function generatePdfExportWrapper(exportContext) {
  return generatePdfExport(exportContext);
}

async function generateReportExportFile(format, exportContext) {
  if (format === "xlsx") {
    return generateXlsxExport(exportContext);
  }

  if (format === "csv") {
    return generateCsvExport(exportContext);
  }

  if (format === "pdf") {
    return generatePdfExportWrapper(exportContext);
  }

  throw new Error("Unsupported export format.");
}

module.exports = {
  generateReportExportFile,
  formatFilterSummary
};
