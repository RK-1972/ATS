const compensationService = require("./compensationService");

const ESI_MONTHLY_WAGE_THRESHOLD = 21000;

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function roundAmount(value) {
  return Number(Number(value || 0).toFixed(2));
}

function findBasicComponent(components) {
  return (
    components.find((item) => item.componentCode === "BASIC_DA") ||
    components.find((item) => String(item.componentName || "").toLowerCase().includes("basic"))
  );
}

function isIncludedInGross(component) {
  return component.componentCategory === "EARNINGS";
}

function formatFormulaLabel(component, resolvedFormula) {
  if (resolvedFormula) {
    return resolvedFormula;
  }

  switch (component.formulaType) {
    case "PERCENT_OF_CTC":
      return `${component.formulaValue}% of CTC`;
    case "PERCENT_OF_BASIC":
      return `${component.formulaValue}% of Basic`;
    case "FIXED":
      return component.fixedAmount != null
        ? `Fixed (${roundAmount(component.fixedAmount)})`
        : "Fixed";
    case "BALANCING":
      return "Balancing (Approved CTC − other CTC components)";
    case "RULE_BASED":
      return "Rule Based";
    default:
      return component.formulaType || "—";
  }
}

function evaluateEmployerEsi(component, context) {
  const percent = Number(component.formulaValue || 3.25);
  const monthlyEarnings = roundAmount(context.monthlyEarnings || 0);

  if (monthlyEarnings > ESI_MONTHLY_WAGE_THRESHOLD) {
    return {
      amount: 0,
      formula: `Employer ESI = 0 (monthly earnings ₹${monthlyEarnings.toLocaleString("en-IN")} exceed statutory threshold ₹${ESI_MONTHLY_WAGE_THRESHOLD.toLocaleString("en-IN")})`
    };
  }

  return {
    amount: roundAmount((context.annualCtc * percent) / 100),
    formula: `${percent}% of CTC (monthly earnings within ESI eligibility threshold)`
  };
}

function evaluateRuleBasedComponent(component, context) {
  if (component.componentCode === "EMPLOYER_ESI") {
    return evaluateEmployerEsi(component, context);
  }

  if (component.componentCode === "BONUS") {
    if (component.fixedAmount != null && component.fixedAmount !== "") {
      return {
        amount: roundAmount(component.fixedAmount),
        formula: `Fixed bonus (${roundAmount(component.fixedAmount)})`
      };
    }

    return {
      amount: 0,
      formula: "Bonus = 0 (no applicable bonus rule for this offer)"
    };
  }

  if (component.fixedAmount != null && component.fixedAmount !== "") {
    return {
      amount: roundAmount(component.fixedAmount),
      formula: `Rule Based (fixed ${roundAmount(component.fixedAmount)})`
    };
  }

  if (component.formulaValue != null && component.formulaValue !== "") {
    return {
      amount: roundAmount(component.formulaValue),
      formula: `Rule Based (${component.formulaValue})`
    };
  }

  return {
    amount: 0,
    formula: "Rule Based (no amount configured)"
  };
}

function evaluateComponentAmount(component, context) {
  switch (component.formulaType) {
    case "FIXED":
      return {
        amount: roundAmount(component.fixedAmount || 0),
        formula: formatFormulaLabel(component)
      };

    case "PERCENT_OF_CTC":
      if (component.componentCode === "EMPLOYER_ESI") {
        return evaluateEmployerEsi(component, context);
      }

      return {
        amount: roundAmount(
          (context.annualCtc * Number(component.formulaValue || 0)) / 100
        ),
        formula: formatFormulaLabel(component)
      };

    case "PERCENT_OF_BASIC":
      return {
        amount: roundAmount(
          (context.basicAmount * Number(component.formulaValue || 0)) / 100
        ),
        formula: formatFormulaLabel(component)
      };

    case "RULE_BASED":
      return evaluateRuleBasedComponent(component, context);

    case "BALANCING":
      return {
        amount: 0,
        formula: formatFormulaLabel(component)
      };

    default:
      return {
        amount: 0,
        formula: component.formulaType || "Unknown"
      };
  }
}

function evaluateStructure(annualCtc, structure, components) {
  const annual = roundAmount(annualCtc);

  if (!annual || annual <= 0) {
    throw httpError("Annual CTC must be greater than zero.", 400);
  }

  if (!structure || !components?.length) {
    throw httpError("Compensation structure is not configured.", 400);
  }

  const orderedComponents = [...components].sort(
    (left, right) => Number(left.displayOrder || 0) - Number(right.displayOrder || 0)
  );
  const balancingComponent = orderedComponents.find(
    (item) => item.formulaType === "BALANCING"
  );
  const basicComponent = findBasicComponent(orderedComponents);
  const amounts = {};
  const formulas = {};
  const trace = [];

  const nonBalancingComponents = orderedComponents.filter(
    (item) => item.formulaType !== "BALANCING"
  );

  nonBalancingComponents.forEach((component) => {
    if (component.formulaType === "FIXED") {
      const result = evaluateComponentAmount(component, { annualCtc: annual, basicAmount: 0 });
      amounts[component.structureComponentId] = result.amount;
      formulas[component.structureComponentId] = result.formula;
    }
  });

  nonBalancingComponents.forEach((component) => {
    if (component.formulaType === "PERCENT_OF_CTC") {
      if (component.componentCode === "EMPLOYER_ESI") {
        return;
      }

      const basicAmount = basicComponent
        ? amounts[basicComponent.structureComponentId] || 0
        : 0;
      const result = evaluateComponentAmount(component, {
        annualCtc: annual,
        basicAmount,
        monthlyEarnings: 0
      });
      amounts[component.structureComponentId] = result.amount;
      formulas[component.structureComponentId] = result.formula;
    }
  });

  const basicAmount = basicComponent
    ? amounts[basicComponent.structureComponentId] || 0
    : 0;

  nonBalancingComponents.forEach((component) => {
    if (component.formulaType === "PERCENT_OF_BASIC") {
      const result = evaluateComponentAmount(component, {
        annualCtc: annual,
        basicAmount
      });
      amounts[component.structureComponentId] = result.amount;
      formulas[component.structureComponentId] = result.formula;
    }
  });

  const hraComponent = orderedComponents.find((item) => item.componentCode === "HRA");
  const hraAmount = hraComponent ? amounts[hraComponent.structureComponentId] || 0 : 0;
  const monthlyEarnings = roundAmount((basicAmount + hraAmount) / 12);

  nonBalancingComponents.forEach((component) => {
    if (component.componentCode === "EMPLOYER_ESI") {
      const result = evaluateEmployerEsi(component, {
        annualCtc: annual,
        basicAmount,
        monthlyEarnings
      });
      amounts[component.structureComponentId] = result.amount;
      formulas[component.structureComponentId] = result.formula;
      return;
    }

    if (component.formulaType === "RULE_BASED") {
      const result = evaluateRuleBasedComponent(component, {
        annualCtc: annual,
        basicAmount,
        monthlyEarnings
      });
      amounts[component.structureComponentId] = result.amount;
      formulas[component.structureComponentId] = result.formula;
    }
  });

  if (balancingComponent) {
    const includedTotal = orderedComponents
      .filter(
        (item) =>
          item.includeInCtc !== false &&
          item.formulaType !== "BALANCING" &&
          item.structureComponentId !== balancingComponent.structureComponentId
      )
      .reduce(
        (sum, item) => sum + Number(amounts[item.structureComponentId] || 0),
        0
      );

    const balancingAmount = roundAmount(annual - includedTotal);
    amounts[balancingComponent.structureComponentId] = balancingAmount;
    formulas[balancingComponent.structureComponentId] =
      `Balancing = Approved CTC (${annual}) − other CTC components (${roundAmount(includedTotal)})`;
  }

  const enrichedComponents = orderedComponents.map((component) => {
    const includeInCtc = component.includeInCtc !== false;
    const includeInGross = isIncludedInGross(component);
    const amount = roundAmount(amounts[component.structureComponentId] || 0);

    const traceEntry = {
      componentName: component.componentName,
      componentCode: component.componentCode,
      formula: formulas[component.structureComponentId] || formatFormulaLabel(component),
      calculatedAmount: amount,
      includedInCtc: includeInCtc,
      includedInGross: includeInGross
    };

    trace.push(traceEntry);

    return {
      structureComponentId: component.structureComponentId,
      componentCode: component.componentCode,
      componentName: component.componentName,
      componentCategory: component.componentCategory,
      formulaType: component.formulaType,
      formula: traceEntry.formula,
      formulaValue: component.formulaValue,
      fixedAmount: component.fixedAmount,
      displayOrder: component.displayOrder,
      includeInCtc,
      includeInGross,
      amount
    };
  });

  const includedInCtcComponents = enrichedComponents.filter((item) => item.includeInCtc);
  const totalCtc = roundAmount(
    includedInCtcComponents.reduce((sum, item) => sum + Number(item.amount || 0), 0)
  );
  const gross = roundAmount(
    includedInCtcComponents
      .filter((item) => item.includeInGross)
      .reduce((sum, item) => sum + Number(item.amount || 0), 0)
  );

  if (Math.abs(totalCtc - annual) >= 0.01) {
    throw httpError(
      `Internal calculation error: CTC component total (${totalCtc}) does not match approved Annual CTC (${annual}).`,
      500
    );
  }

  const rows = includedInCtcComponents.map((component) => ({
    componentName: component.componentName,
    amount: component.amount,
    displayOrder: component.displayOrder
  }));

  return {
    structure,
    components: enrichedComponents,
    calculationTrace: trace,
    rows,
    gross,
    totalCtc: annual,
    verifiedCtcTotal: totalCtc
  };
}

async function evaluateStructureForOffer(pool, annualCtc) {
  const { structure, components } =
    await compensationService.getDefaultStructureComponents(pool);

  return evaluateStructure(annualCtc, structure, components);
}

function isEvaluationEnabled() {
  return true;
}

module.exports = {
  roundAmount,
  formatFormulaLabel,
  evaluateStructure,
  evaluateStructureForOffer,
  isEvaluationEnabled,
  ESI_MONTHLY_WAGE_THRESHOLD
};
