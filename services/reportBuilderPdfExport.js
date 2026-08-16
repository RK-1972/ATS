const PDFDocument = require("pdfkit");

const {
  formatExportCellValue,
  formatExportGeneratedTimestamp,
  buildExportFilename
} = require("../utils/reportExportFormatters");

const OPTALYNX_BLUE = "#1f3b63";
const OPTALYNX_ORANGE = "#f39c12";
const ROW_STRIPE = "#f5f7fb";
const BORDER_COLOR = "#d0d7e2";
const HEADER_TEXT = "#ffffff";
const BODY_TEXT = "#222222";
const MUTED_TEXT = "#555555";

const PAGE_SIZE = "A4";
const A4_PORTRAIT = { width: 595.28, height: 841.89 };
const CELL_PAD_X = 6;
const CELL_PAD_Y = 5;
const MIN_ROW_HEIGHT = 20;
const MIN_HEADER_HEIGHT = 24;
const FOOTER_RESERVED = 26;

function formatFilterLines(filters = []) {
  if (!filters.length) {
    return ["None"];
  }

  return filters.map((filter) => {
    const label = filter.field?.label || filter.field?.code || "Field";
    const operator = String(filter.operator || "equals").replace(/_/g, " ");
    const value = Array.isArray(filter.value)
      ? filter.value.join(", ")
      : String(filter.value ?? "");
    return `${label} ${operator} ${value}`;
  });
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

function resolvePageDimensions(layout) {
  if (layout === "landscape") {
    return { width: A4_PORTRAIT.height, height: A4_PORTRAIT.width };
  }

  return { width: A4_PORTRAIT.width, height: A4_PORTRAIT.height };
}

function resolvePdfLayout(columns) {
  const portraitContentWidth = A4_PORTRAIT.width - 80;
  const minTotal = columns.reduce(
    (sum, column) => sum + getColumnMinWidth(column, columns.length),
    0
  );

  if (columns.length >= 5) {
    return "landscape";
  }

  if (columns.length >= 4 && minTotal > portraitContentWidth * 0.9) {
    return "landscape";
  }

  return "portrait";
}

function getColumnMinWidth(column, columnCount) {
  let min = 48;

  if (column.data_type === "date") {
    min = 62;
  } else if (column.data_type === "number") {
    min = 46;
  } else if (column.data_type === "enum") {
    min = 50;
  }

  if (columnCount >= 10) {
    min *= 0.82;
  } else if (columnCount >= 8) {
    min *= 0.9;
  }

  return min;
}

function getColumnWeight(column) {
  let weight = String(column.label || column.code).length;

  if (column.data_type === "text") {
    weight *= 1.25;
  }

  if (column.data_type === "date") {
    weight = Math.max(weight, 12);
  }

  return Math.max(weight, 6);
}

function computeColumnWidths(columns, contentWidth) {
  if (!columns.length) {
    return [];
  }

  const mins = columns.map((column) => getColumnMinWidth(column, columns.length));
  const weights = columns.map(getColumnWeight);
  const minTotal = mins.reduce((sum, value) => sum + value, 0);

  let widths;

  if (minTotal >= contentWidth) {
    widths = mins.map((min) => (min / minTotal) * contentWidth);
  } else {
    widths = [...mins];
    let remaining = contentWidth - minTotal;
    const totalWeight = weights.reduce((sum, value) => sum + value, 0);

    widths = widths.map((min, index) => {
      const extra = totalWeight > 0 ? (weights[index] / totalWeight) * remaining : 0;
      return min + extra;
    });
  }

  const sum = widths.reduce((total, width) => total + width, 0);
  const drift = contentWidth - sum;

  if (Math.abs(drift) > 0.01) {
    widths[widths.length - 1] += drift;
  }

  return widths;
}

function resolveFontSizes(columnCount) {
  if (columnCount >= 11) {
    return { header: 6.5, body: 6.5, metadata: 8 };
  }

  if (columnCount >= 9) {
    return { header: 7, body: 7, metadata: 8 };
  }

  if (columnCount >= 7) {
    return { header: 7.5, body: 7.5, metadata: 8.5 };
  }

  return { header: 8, body: 8, metadata: 9 };
}

function getCellAlignment(column) {
  if (column.data_type === "number") {
    return "right";
  }

  return "left";
}

function resetCursor(doc, geometry, y) {
  doc.x = geometry.margins.left;
  doc.y = y;
}

function measureWrappedHeight(doc, text, width, fontName, fontSize, align = "left") {
  doc.font(fontName).fontSize(fontSize);
  return doc.heightOfString(String(text ?? ""), {
    width: Math.max(width, 8),
    align
  });
}

function wrapTextToHeight(doc, text, width, maxHeight, fontName, fontSize) {
  doc.font(fontName).fontSize(fontSize);
  const raw = String(text ?? "").trim();

  if (!raw) {
    return "";
  }

  const words = raw.split(/\s+/);
  const lines = [];
  let current = "";

  words.forEach((word) => {
    const candidate = current ? `${current} ${word}` : word;

    if (doc.widthOfString(candidate) <= width) {
      current = candidate;
      return;
    }

    if (current) {
      lines.push(current);
    }

    current = word;
  });

  if (current) {
    lines.push(current);
  }

  const lineHeight = doc.currentLineHeight(true);
  const maxLines = Math.max(1, Math.floor(maxHeight / lineHeight));
  let kept = lines.slice(0, maxLines);

  if (lines.length > maxLines && kept.length > 0) {
    kept[kept.length - 1] = `${kept[kept.length - 1]}…`;
  }

  return kept.join("\n");
}

function measureWrappedBlockHeight(doc, text, width, fontName, fontSize) {
  doc.font(fontName).fontSize(fontSize);
  return doc.heightOfString(String(text ?? ""), { width, lineGap: 0 });
}

function drawFooterOnPage(doc, geometry, pageNumber, datasetName) {
  const footerY = geometry.pageHeight - geometry.margins.bottom + 8;
  const pageLabel = `Page ${pageNumber}`;
  const leftText = `OPTALYNX | ${datasetName}`;

  doc.save();
  doc.font("Helvetica").fontSize(7).fillColor("#888888");
  const pageLabelWidth = doc.widthOfString(pageLabel);
  doc.text(leftText, geometry.margins.left, footerY, { lineBreak: false });
  doc.text(
    pageLabel,
    geometry.margins.left + geometry.contentWidth - pageLabelWidth,
    footerY,
    { lineBreak: false }
  );
  doc.restore();
  resetCursor(doc, geometry, geometry.margins.top);
}

function drawDocumentHeader(doc, context, geometry, fontSizes) {
  const { dataset, filters, totalCount } = context;
  const generatedAt = formatExportGeneratedTimestamp();
  const labelWidth = 88;
  let y = geometry.margins.top;

  doc.fillColor(OPTALYNX_BLUE).font("Helvetica-Bold").fontSize(20)
    .text("OPTALYNX", geometry.margins.left, y, { lineBreak: false });
  y += 22;

  doc.moveTo(geometry.margins.left, y)
    .lineTo(geometry.margins.left + 72, y)
    .lineWidth(2)
    .strokeColor(OPTALYNX_ORANGE)
    .stroke();
  y += 10;

  doc.fillColor(MUTED_TEXT).font("Helvetica").fontSize(fontSizes.metadata)
    .text("Report Builder", geometry.margins.left, y, { lineBreak: false });
  y += 16;

  [
    ["Dataset", dataset.name],
    ["Generated", generatedAt],
    ["Total records", String(totalCount ?? 0)]
  ].forEach(([label, value]) => {
    doc.fillColor("#444444").font("Helvetica-Bold").fontSize(fontSizes.metadata)
      .text(`${label}:`, geometry.margins.left, y, { width: labelWidth, lineBreak: false });
    doc.font("Helvetica").fillColor("#333333")
      .text(value, geometry.margins.left + labelWidth, y, {
        width: geometry.contentWidth - labelWidth,
        lineBreak: false
      });
    y += 13;
  });

  y += 1;
  doc.fillColor("#444444").font("Helvetica-Bold").fontSize(fontSizes.metadata)
    .text("Filters:", geometry.margins.left, y, { lineBreak: false });
  y += 12;

  formatFilterLines(filters).forEach((line) => {
    doc.font("Helvetica").fillColor(MUTED_TEXT).fontSize(fontSizes.metadata)
      .text(`• ${line}`, geometry.margins.left + 6, y, {
        width: geometry.contentWidth - 6,
        lineBreak: true
      });
    y = doc.y + 2;
  });

  y += 6;
  doc.fillColor(OPTALYNX_BLUE).font("Helvetica-Bold").fontSize(10)
    .text("RESULTS", geometry.margins.left, y, { lineBreak: false });
  y += 12;

  doc.moveTo(geometry.margins.left, y)
    .lineTo(geometry.margins.left + geometry.contentWidth, y)
    .lineWidth(0.5)
    .strokeColor("#cccccc")
    .stroke();
  y += 10;

  resetCursor(doc, geometry, y);
  return y;
}

function createTableRenderer(doc, geometry, columns, columnWidths, fontSizes) {
  function measureHeaderHeight() {
    let maxHeight = MIN_HEADER_HEIGHT;

    columns.forEach((column, index) => {
      const innerWidth = columnWidths[index] - CELL_PAD_X * 2;
      const height =
        measureWrappedHeight(
          doc,
          column.label,
          innerWidth,
          "Helvetica-Bold",
          fontSizes.header
        ) +
        CELL_PAD_Y * 2;
      maxHeight = Math.max(maxHeight, height);
    });

    return maxHeight;
  }

  function drawTableHeader(startY) {
    const headerHeight = measureHeaderHeight();
    let x = geometry.margins.left;

    columns.forEach((column, index) => {
      doc.save();
      doc.rect(x, startY, columnWidths[index], headerHeight).fill(OPTALYNX_BLUE);
      doc.fillColor(HEADER_TEXT).font("Helvetica-Bold").fontSize(fontSizes.header)
        .text(column.label, x + CELL_PAD_X, startY + CELL_PAD_Y, {
          width: columnWidths[index] - CELL_PAD_X * 2,
          align: "left",
          lineBreak: true
        });
      doc.rect(x, startY, columnWidths[index], headerHeight).stroke(BORDER_COLOR);
      doc.restore();
      x += columnWidths[index];
    });

    resetCursor(doc, geometry, startY + headerHeight);
    return startY + headerHeight;
  }

  function measureRowHeight(row) {
    const MAX_ROW_HEIGHT = 44;
    let maxHeight = MIN_ROW_HEIGHT;

    columns.forEach((column, index) => {
      const innerWidth = columnWidths[index] - CELL_PAD_X * 2;
      const wrapped = wrapTextToHeight(
        doc,
        row[column.code],
        innerWidth,
        MAX_ROW_HEIGHT - CELL_PAD_Y * 2,
        "Helvetica",
        fontSizes.body
      );
      const contentHeight = measureWrappedBlockHeight(
        doc,
        wrapped,
        innerWidth,
        "Helvetica",
        fontSizes.body
      );
      maxHeight = Math.max(maxHeight, Math.min(contentHeight + CELL_PAD_Y * 2, MAX_ROW_HEIGHT));
    });

    return maxHeight;
  }

  function drawRow(row, rowIndex, startY) {
    const rowHeight = measureRowHeight(row);
    let x = geometry.margins.left;
    const background = rowIndex % 2 === 0 ? "#ffffff" : ROW_STRIPE;
    const innerHeight = rowHeight - CELL_PAD_Y * 2;

    columns.forEach((column, index) => {
      const innerWidth = columnWidths[index] - CELL_PAD_X * 2;
      const displayValue = wrapTextToHeight(
        doc,
        row[column.code],
        innerWidth,
        innerHeight,
        "Helvetica",
        fontSizes.body
      );

      doc.save();
      doc.rect(x, startY, columnWidths[index], rowHeight).fill(background);
      doc.fillColor(BODY_TEXT).font("Helvetica").fontSize(fontSizes.body)
        .text(displayValue, x + CELL_PAD_X, startY + CELL_PAD_Y, {
          width: innerWidth,
          lineBreak: false,
          align: getCellAlignment(column)
        });
      doc.rect(x, startY, columnWidths[index], rowHeight).stroke(BORDER_COLOR);
      doc.restore();
      x += columnWidths[index];
    });

    resetCursor(doc, geometry, startY + rowHeight);
    return startY + rowHeight;
  }

  return {
    drawTableHeader,
    measureRowHeight,
    drawRow
  };
}

function generatePdfExport(exportContext) {
  const { dataset, columns, rows, filters, totalCount } = exportContext;
  const layout = resolvePdfLayout(columns);
  const margins = { top: 44, bottom: 52, left: 40, right: 40 };
  const pageOptions = {
    size: PAGE_SIZE,
    layout,
    margins,
    bufferPages: true,
    autoFirstPage: true
  };
  const pageDimensions = resolvePageDimensions(layout);
  const geometry = {
    layout,
    margins,
    pageWidth: pageDimensions.width,
    pageHeight: pageDimensions.height,
    contentWidth: pageDimensions.width - margins.left - margins.right,
    contentBottomY: pageDimensions.height - margins.bottom - FOOTER_RESERVED
  };

  const doc = new PDFDocument(pageOptions);
  const chunks = [];
  doc.on("data", (chunk) => chunks.push(chunk));

  const finished = new Promise((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const columnWidths = computeColumnWidths(columns, geometry.contentWidth);
  const tableWidth = columnWidths.reduce((sum, width) => sum + width, 0);

  if (tableWidth > geometry.contentWidth + 0.5) {
    return Promise.reject(
      new Error("Report PDF table width exceeds printable page area.")
    );
  }

  const fontSizes = resolveFontSizes(columns.length);
  const formattedRows = mapRowsForExport(columns, rows);
  const table = createTableRenderer(doc, geometry, columns, columnWidths, fontSizes);

  let y = drawDocumentHeader(
    doc,
    { dataset, filters, totalCount: totalCount ?? rows.length },
    geometry,
    fontSizes
  );

  if (rows.length === 0) {
    y += 4;
    doc.fillColor(MUTED_TEXT).font("Helvetica-Oblique").fontSize(10)
      .text("No records match the selected criteria.", geometry.margins.left, y, {
        width: geometry.contentWidth,
        lineBreak: true
      });
    resetCursor(doc, geometry, doc.y);

    const range = doc.bufferedPageRange();
    for (let pageIndex = 0; pageIndex < range.count; pageIndex += 1) {
      doc.switchToPage(range.start + pageIndex);
      drawFooterOnPage(doc, geometry, pageIndex + 1, dataset.name);
    }

    doc.end();

    return finished.then((buffer) => ({
      buffer,
      contentType: "application/pdf",
      filename: buildExportFilename(dataset.code, "pdf")
    }));
  }

  y = table.drawTableHeader(y);

  formattedRows.forEach((row, rowIndex) => {
    const rowHeight = table.measureRowHeight(row);

    if (y + rowHeight > geometry.contentBottomY) {
      doc.addPage(pageOptions);
      y = table.drawTableHeader(geometry.margins.top);
    }

    y = table.drawRow(row, rowIndex, y);
  });

  const range = doc.bufferedPageRange();
  for (let pageIndex = 0; pageIndex < range.count; pageIndex += 1) {
    doc.switchToPage(range.start + pageIndex);
    drawFooterOnPage(doc, geometry, pageIndex + 1, dataset.name);
  }

  doc.end();

  return finished.then((buffer) => ({
    buffer,
    contentType: "application/pdf",
    filename: buildExportFilename(dataset.code, "pdf")
  }));
}

module.exports = {
  generatePdfExport,
  computeColumnWidths,
  resolvePdfLayout,
  resolvePageDimensions,
  formatFilterLines
};
