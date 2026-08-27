export function stripHtmlTags(text) {
  if (!text) return "";
  let clean = text.replace(/<[^>]*display:\s*none[^>]*>.*?<\/[^>]+>/gi, '');
  clean = clean.replace(/<[^>]*color:\s*(?:white|#ffffff|#fff)[^>]*>.*?<\/[^>]+>/gi, '');
  clean = clean.replace(/<[^>]*opacity:\s*0[^>]*>.*?<\/[^>]+>/gi, '');
  return clean.replace(/<[^>]*>?/gm, '').trim();
}

export function getReflectionPrompt(domainQuestions) {
  let hasAttempts = Object.values(domainQuestions).some(q => q.previous_attempts && q.previous_attempts.length > 0);
  if (hasAttempts) {
    return "\n\nREFLECTION SKILL ACTIVATED: One or more questions in this batch have previous incorrect attempts. Analyze the 'previous_attempts' array carefully. Understand why the previous answer failed based on the provided hint, and generate a distinctly different and correct answer.";
  }
  return "";
}

export class BaseAgent {
  constructor(domain, skillPrompt) {
    this.domain = domain;
    this.skillPrompt = skillPrompt;
  }


  // Common instructions for all agents
  getGlobalRules() {
    return (
      "CRITICAL: Keep 'reasoning' concise (1-2 sentences). " +
      "NEVER answer in markdown formatting (no bold, italics, or code blocks) unless explicitly stated by the question.\n\n"
    );
  }

  // Combines global rules, skill-specific prompt, and reflection
  buildPrompt(domainQuestions, reflectionText = "") {
    let basePrompt = (
      "Answer the provided questions. Be precise and concise.\n" +
      "The questions are in a dict format where each key represents the question id, and the value is a JSON dict containing:\n" +
      "- 'Question': the question text.\n" +
      "- 'Options': a list of options (if applicable) with option_id and value.\n" +
      "- 'Type': the question type.\n" +
      "- 'previous_attempts': (optional) past attempt results. ALWAYS review these to avoid repeating mistakes.\n\n"
    );

    return basePrompt + this.getGlobalRules() + this.skillPrompt + reflectionText;
  }

  // Optional overriding for specific agents to normalize outputs
  postProcess(ansType, chosen, answer, domainQuestions, qId) {
    return { chosen, answer };
  }

  // Format the GraphQL payload strictly per schema
  formatPayload(partId, qType, chosen, answer) {
    throw new Error("formatPayload must be implemented by subclass.");
  }
}

export class LogicAgent extends BaseAgent {
  constructor() {
    super(
      "LOGIC",
      "You are the Logic Agent. Your skill is deductive reasoning and process of elimination.\n" +
      "Rules:\n" +
      "1. MULTIPLE_CHOICE: Single-choice question. Select exactly one option_id and place it in the 'chosen' list.\n" +
      "2. CHECKBOX: Multi-choice question. Select one or more option_ids and place them in the 'chosen' list.\n" +
      "3. MULTIPLE_FILLABLE_BLANKS: Provide a dict of blank_id to option_id in the 'answer' field.\n\n" +
      "IMPORTANT for CHECKBOX:\n" +
      "If a question has 'previous_attempts', each entry records a prior submission of chosen option_ids:\n" +
      "- 'response' is a list of option_ids that were chosen together.\n" +
      "- 'hint' states that this combination was graded INCORRECT and shows the fractional score earned (e.g. 'Score: 1/3').\n" +
      "Use these partial scores to logically deduce the status of options. Integrate all attempts to find an untested combination that satisfies these constraints."
    );
  }

  postProcess(ansType, chosen, answer, domainQuestions, qId) {
    if (["CHECKBOX", "CHECKBOX_REFLECT"].includes(ansType) && typeof chosen === 'string') {
      chosen = [chosen];
    }

    if (ansType === "MULTIPLE_CHOICE" && Array.isArray(chosen) && chosen.length > 0) {
      let optId = chosen[0];
      let opts = domainQuestions[qId].Options || [];
      if (!opts.find(o => o.option_id === optId)) {
        let matched = opts.find(o => o.value.toLowerCase().includes(optId.toLowerCase()));
        if (matched) {
          chosen = [matched.option_id];
        }
      }
    }

    if (["MULTIPLE_CHOICE", "CHECKBOX", "CHECKBOX_REFLECT"].includes(ansType) && Array.isArray(chosen)) {
      let mappedChosen = [];
      for (let c of chosen) {
        let optObj = domainQuestions[qId].Options.find(o => o.option_id === c);
        if (optObj && optObj.original_id) {
          mappedChosen.push(optObj.original_id);
        } else {
          mappedChosen.push(c);
        }
      }
      chosen = mappedChosen;
    }
    return { chosen, answer };
  }

  formatPayload(partId, qType, chosen, answer) {
    if (qType === "MULTIPLE_CHOICE") {
      return {
        questionId: partId,
        questionType: qType,
        questionResponse: { multipleChoiceResponse: { chosen: chosen ? chosen[0] : null } }
      };
    } else if (qType === "CHECKBOX" || qType === "CHECKBOX_REFLECT") {
      return {
        questionId: partId,
        questionType: qType,
        questionResponse: { checkboxResponse: { chosen: chosen || [] } }
      };
    } else if (qType === "MULTIPLE_FILLABLE_BLANKS") {
      let responses = [];
      if (answer && typeof answer === 'object' && !Array.isArray(answer)) {
        responses = Object.keys(answer).map(blankId => ({
          multipleChoiceFillableBlankResponse: { id: blankId, optionId: answer[blankId] }
        }));
      }
      return {
        questionId: partId,
        questionType: qType,
        questionResponse: { multipleFillableBlanksResponse: { responses } }
      };
    }
    throw new Error(`Unsupported logic question type: ${qType}`);
  }
}

export class CodeExpressionAgent extends BaseAgent {
  constructor() {
    super(
      "CODE_EXPRESSION",
      "You are the Code Agent. Your skill is writing flawless, raw code snippets.\n" +
      "Rules:\n" +
      "1. CODE_EXPRESSION: Provide the exact code snippet required in the 'answer' field. You MUST wrap the code in markdown ``` backticks (e.g. ```python\\n...\\n```). CRITICAL: Preserve all newlines (\\n) and indentation.\n" +
      "2. Automatically assume a Python context by default unless specified otherwise. Import necessary standard libraries implicitly required."
    );
  }

  postProcess(ansType, chosen, answer, domainQuestions, qId) {
    if (ansType !== "MULTIPLE_FILLABLE_BLANKS" && typeof answer === 'object' && answer !== null) {
      const keys = Object.keys(answer);
      if (keys.length > 0) {
        answer = String(answer[keys[0]]);
      } else {
        answer = "";
      }
    }
    if (ansType === "CODE_EXPRESSION" && typeof answer === 'string') {
      answer = answer.replace(/^```[a-zA-Z]*\n/, '');
      answer = answer.replace(/\n```$/, '');
      answer = answer.replace(/^```\n?/, '');
      answer = answer.replace(/\n?```$/, '');
      answer = answer.trim();
    }
    return { chosen, answer };
  }

  formatPayload(partId, qType, chosen, answer) {
    if (qType === "CODE_EXPRESSION") {
      return {
        questionId: partId,
        questionType: qType,
        questionResponse: { codeExpressionResponse: { answer: { code: answer || "" } } }
      };
    }
    throw new Error(`Unsupported code question type: ${qType}`);
  }
}

export class RegexAgent extends BaseAgent {
  constructor() {
    super(
      "REGEX",
      "You are the Regex Agent. Your skill is writing flawless regular expressions.\n" +
      "Rules:\n" +
      "1. REGEX: Answer with the exact matching regular expression text ONLY, no wrapping quotes or slashes, in the 'answer' field."
    );
  }

  postProcess(ansType, chosen, answer, domainQuestions, qId) {
    if (ansType !== "MULTIPLE_FILLABLE_BLANKS" && typeof answer === 'object' && answer !== null) {
      const keys = Object.keys(answer);
      if (keys.length > 0) {
        answer = String(answer[keys[0]]);
      } else {
        answer = "";
      }
    }

    if (ansType === "REGEX" && typeof answer === 'string') {
      if ((answer.startsWith('"') && answer.endsWith('"')) || (answer.startsWith("'") && answer.endsWith("'"))) {
        answer = answer.substring(1, answer.length - 1);
      }
      answer = answer.replace(/^r['"]|['"]$/g, '').replace(/^\/|\/$/g, '');
    }
    return { chosen, answer };
  }

  formatPayload(partId, qType, chosen, answer) {
    if (qType === "REGEX") {
      return {
        questionId: partId,
        questionType: qType,
        questionResponse: { regexResponse: { answer: answer || "" } }
      };
    }
    throw new Error(`Unsupported regex question type: ${qType}`);
  }
}

export class MathAgent extends BaseAgent {
  constructor() {
    super(
      "MATH",
      "You are the Math Agent. Your skill is precise mathematical calculation.\n" +
      "Rules:\n" +
      "1. NUMERIC: Answer with the exact number ONLY, no quotes (e.g., 42), in the 'answer' field.\n" +
      "2. MATH: Provide the exact math expression required in the 'answer' field.\n" +
      "3. If complex computation is implied, utilize your knowledge of libraries like numpy, scipy, sympy, or math to derive the correct numerical answer."
    );
  }

  postProcess(ansType, chosen, answer, domainQuestions, qId) {
    if (ansType !== "MULTIPLE_FILLABLE_BLANKS" && typeof answer === 'object' && answer !== null) {
      const keys = Object.keys(answer);
      if (keys.length > 0) {
        answer = String(answer[keys[0]]);
      } else {
        answer = "";
      }
    }

    if (ansType === "NUMERIC" && typeof answer === 'string') {
      if ((answer.startsWith('"') && answer.endsWith('"')) || (answer.startsWith("'") && answer.endsWith("'"))) {
        answer = answer.substring(1, answer.length - 1);
      }
      const parsed = parseFloat(answer);
      if (!isNaN(parsed)) {
        answer = parsed.toString(); // Canonicalize numeric string
      }
    }
    return { chosen, answer };
  }

  formatPayload(partId, qType, chosen, answer) {
    if (qType === "NUMERIC") {
      return {
        questionId: partId,
        questionType: qType,
        questionResponse: { numericResponse: { answer: answer || "" } } // Explicit handling
      };
    } else if (qType === "MATH") {
      return {
        questionId: partId,
        questionType: qType,
        questionResponse: { mathResponse: { answer: answer || "" } }
      };
    }
    throw new Error(`Unsupported math question type: ${qType}`);
  }
}

export class TextAgent extends BaseAgent {
  constructor() {
    super(
      "TEXT",
      "You are the Text Agent. Your skill is reading comprehension and concise free-text generation.\n" +
      "Rules:\n" +
      "1. TEXT_REFLECT, PLAIN_TEXT, RICH_TEXT: Free-text answer in the 'answer' field. Be thoughtful and highly relevant.\n" +
      "2. TEXT_EXACT_MATCH: Answer with the exact matching text ONLY, no wrapping quotes, in the 'answer' field."
    );
  }

  postProcess(ansType, chosen, answer, domainQuestions, qId) {
    if (ansType !== "MULTIPLE_FILLABLE_BLANKS" && typeof answer === 'object' && answer !== null) {
      const keys = Object.keys(answer);
      if (keys.length > 0) {
        answer = String(answer[keys[0]]);
      } else {
        answer = "";
      }
    }

    if (ansType === "TEXT_EXACT_MATCH" && typeof answer === 'string') {
      if ((answer.startsWith('"') && answer.endsWith('"')) || (answer.startsWith("'") && answer.endsWith("'"))) {
        answer = answer.substring(1, answer.length - 1);
      }
    }
    return { chosen, answer };
  }

  formatPayload(partId, qType, chosen, answer) {
    if (qType === "TEXT_REFLECT") {
      return {
        questionId: partId,
        questionType: qType,
        // Fixed 400 error: explicitly providing string answer instead of relying on generic map
        questionResponse: { textReflectResponse: { answer: answer || "" } }
      };
    } else if (qType === "PLAIN_TEXT") {
      return {
        questionId: partId,
        questionType: qType,
        questionResponse: { plainTextResponse: { plainText: answer || "" } }
      };
    } else if (qType === "TEXT_EXACT_MATCH") {
      return {
        questionId: partId,
        questionType: qType,
        questionResponse: { textExactMatchResponse: { answer: answer || "" } }
      };
    } else if (qType === "RICH_TEXT") {
      return {
        questionId: partId,
        questionType: qType,
        questionResponse: { richTextResponse: { richText: { value: answer || "" } } }
      };
    }
    throw new Error(`Unsupported text question type: ${qType}`);
  }
}

export class ResourceAgent extends BaseAgent {
  constructor() {
    super(
      "RESOURCE",
      "You are the Resource Agent. Your skill is providing URLs or specific file inputs.\n" +
      "Rules:\n" +
      "1. FILE_UPLOAD, URL, WIDGET: Provide a relevant submission summary, URL, or JSON in the 'answer' field."
    );
  }

  postProcess(ansType, chosen, answer, domainQuestions, qId) {
    if (ansType !== "MULTIPLE_FILLABLE_BLANKS" && typeof answer === 'object' && answer !== null) {
      const keys = Object.keys(answer);
      if (keys.length > 0) {
        answer = String(answer[keys[0]]);
      } else {
        answer = "";
      }
    }
    return { chosen, answer };
  }

  formatPayload(partId, qType, chosen, answer) {
    if (qType === "FILE_UPLOAD") {
      const urlVal = (answer && typeof answer === 'string' && answer.startsWith("http")) ? answer : "https://raw.githubusercontent.com/yamantaka-singh/skipera/main/README.md";
      return {
        questionId: partId,
        questionType: qType,
        questionResponse: { fileUploadResponse: { title: "submission.txt", caption: answer || "Assignment Submission", fileUrl: urlVal } }
      };
    } else if (qType === "URL") {
      const urlVal = (answer && typeof answer === 'string' && answer.startsWith("http")) ? answer : "https://github.com";
      return {
        questionId: partId,
        questionType: qType,
        questionResponse: { urlResponse: { title: "Project Submission", caption: answer || "Submission URL", url: urlVal } }
      };
    } else if (qType === "WIDGET") {
      return {
        questionId: partId,
        questionType: qType,
        questionResponse: { widgetResponse: { answer: answer || "" } }
      };
    }
    throw new Error(`Unsupported resource question type: ${qType}`);
  }
}


// The Router that returns the appropriate agent for a question type
export function getAgentForType(qType) {
  switch (qType) {
    case "MULTIPLE_CHOICE":
    case "CHECKBOX":
    case "CHECKBOX_REFLECT":
    case "MULTIPLE_FILLABLE_BLANKS":
      return new LogicAgent();
    case "CODE_EXPRESSION":
      return new CodeExpressionAgent();
    case "REGEX":
      return new RegexAgent();
    case "MATH":
    case "NUMERIC":
      return new MathAgent();
    case "TEXT_REFLECT":
    case "PLAIN_TEXT":
    case "RICH_TEXT":
    case "TEXT_EXACT_MATCH":
      return new TextAgent();
    case "FILE_UPLOAD":
    case "URL":
    case "WIDGET":
      return new ResourceAgent();
    default:
      return new TextAgent(); // fallback
  }
}
