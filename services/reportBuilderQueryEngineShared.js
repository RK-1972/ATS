function quoteIdentifier(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

function buildFilterPredicate(filter, params, paramIndexRef) {
  const expression = filter.field.sql_expression;
  const operator = filter.operator;
  const dataType = filter.field.data_type;

  if (dataType === "enum" && filter.field.code === "is_active") {
    const boolValue = filter.value === true || filter.value === "true";
    const paramIndex = paramIndexRef.value;
    params.push(boolValue);
    paramIndexRef.value += 1;
    return `${expression} = $${paramIndex}`;
  }

  if (operator === "equals") {
    const paramIndex = paramIndexRef.value;
    params.push(filter.value);
    paramIndexRef.value += 1;

    if (dataType === "text" || dataType === "enum" || dataType === "reference") {
      return `LOWER((${expression})::text) = LOWER($${paramIndex}::text)`;
    }

    return `${expression} = $${paramIndex}`;
  }

  if (operator === "contains") {
    const paramIndex = paramIndexRef.value;
    params.push(`%${filter.value}%`);
    paramIndexRef.value += 1;
    return `(${expression})::text ILIKE $${paramIndex}`;
  }

  if (operator === "starts_with") {
    const paramIndex = paramIndexRef.value;
    params.push(`${filter.value}%`);
    paramIndexRef.value += 1;
    return `(${expression})::text ILIKE $${paramIndex}`;
  }

  if (operator === "ends_with") {
    const paramIndex = paramIndexRef.value;
    params.push(`%${filter.value}`);
    paramIndexRef.value += 1;
    return `(${expression})::text ILIKE $${paramIndex}`;
  }

  if (operator === "in") {
    const paramIndex = paramIndexRef.value;
    params.push(filter.value);
    paramIndexRef.value += 1;
    return `(${expression})::text = ANY($${paramIndex}::text[])`;
  }

  if (operator === "greater_than") {
    const paramIndex = paramIndexRef.value;
    params.push(filter.value);
    paramIndexRef.value += 1;
    return `${expression} > $${paramIndex}`;
  }

  if (operator === "greater_than_or_equal") {
    const paramIndex = paramIndexRef.value;
    params.push(filter.value);
    paramIndexRef.value += 1;
    return `${expression} >= $${paramIndex}`;
  }

  if (operator === "less_than") {
    const paramIndex = paramIndexRef.value;
    params.push(filter.value);
    paramIndexRef.value += 1;
    return `${expression} < $${paramIndex}`;
  }

  if (operator === "less_than_or_equal") {
    const paramIndex = paramIndexRef.value;
    params.push(filter.value);
    paramIndexRef.value += 1;
    return `${expression} <= $${paramIndex}`;
  }

  if (operator === "before") {
    const paramIndex = paramIndexRef.value;
    params.push(filter.value);
    paramIndexRef.value += 1;
    return `${expression} < $${paramIndex}::timestamptz`;
  }

  if (operator === "after") {
    const paramIndex = paramIndexRef.value;
    params.push(filter.value);
    paramIndexRef.value += 1;
    return `${expression} > $${paramIndex}::timestamptz`;
  }

  if (operator === "between") {
    const startIndex = paramIndexRef.value;
    params.push(filter.value[0]);
    paramIndexRef.value += 1;
    const endIndex = paramIndexRef.value;
    params.push(filter.value[1]);
    paramIndexRef.value += 1;

    if (dataType === "date") {
      return `${expression} BETWEEN $${startIndex}::timestamptz AND $${endIndex}::timestamptz`;
    }

    return `${expression} BETWEEN $${startIndex} AND $${endIndex}`;
  }

  throw new Error("Unsupported filter operator.");
}

module.exports = {
  quoteIdentifier,
  buildFilterPredicate
};
