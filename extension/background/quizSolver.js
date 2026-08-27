// quizSolver.js
import { fetchCoursera, delay } from './courseraApi.js';
import { GET_STATE_QUERY, INITIATE_ATTEMPT_QUERY, SAVE_RESPONSES_QUERY, SUBMIT_DRAFT_QUERY, ASSIGNMENT_FEEDBACK_QUERY } from './queries.js';
import { callLLMProvider } from './llmProviders.js';
import { getAgentForType, getReflectionPrompt, stripHtmlTags } from './agents.js';

async function fetchGraphQL(opname, query, variables) {
  const res = await fetchCoursera("https://www.coursera.org/graphql-gateway", {
    method: "POST",
    headers: {
      "x-coursera-version": "123",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      operationName: opname,
      variables: variables,
      query: query
    })
  });
  if (!res.ok) {
     const text = await res.text();
     throw new Error(`GraphQL API returned ${res.status}: ${text.substring(0, 100)}...`);
  }
  const contentType = res.headers.get("content-type");
  if (!contentType || !contentType.includes("application/json")) {
     const text = await res.text();
     throw new Error(`Expected JSON but got ${contentType}: ${text.substring(0, 100)}...`);
  }
  const data = await res.json();
  if (data.errors) throw new Error(`GraphQL Error: ${JSON.stringify(data.errors)}`);
  return data;
}

const TEXT_ANSWER_TYPES = new Set(["TEXT_REFLECT", "NUMERIC", "PLAIN_TEXT", "TEXT_EXACT_MATCH", "REGEX", "FILE_UPLOAD", "URL", "CODE_EXPRESSION", "MATH", "RICH_TEXT", "WIDGET"]);

async function callLLM(unsolvedQuestions, settings, systemPrompt) {
  const userPrompt = JSON.stringify(unsolvedQuestions, null, 2);
  const keys = settings.apiKey.split(",").map(k => k.trim()).filter(k => k);
  const provider = settings.provider || "nvidia";
  
  return await callLLMProvider(provider, keys, settings.modelName, systemPrompt, userPrompt);
}

import { updateDashboard } from './dashboardStore.js';

export async function triggerQuizSolver(courseId, itemId, settings, tabId, courseSlug = "default", runContext = null) {
  const safeSlug = courseSlug || "default";
  const updateProgress = (msg, overrideType) => {
    let type = overrideType || "info";
    if (!overrideType) {
      if (msg.includes("ERROR") || msg.includes("Failed") || msg.includes("Error")) type = "error";
      else if (msg.includes("Complete") || msg.includes("successfully") || msg.includes("Passed")) type = "complete";
      else if (msg.includes("Starting") || msg.includes("Processing") || msg.includes("Triggering")) type = "active";
    }
    updateDashboard(msg, type, safeSlug);
  };
  
  updateProgress(`Starting quiz solver for courseId: ${courseId}, itemId: ${itemId}`);
  
  try {
  
  let targetGrade = 0.8;
  let maxAttempts = 3;
  let attemptsMade = 0;
  
  // Local cache for correctness
  let questionsData = {}; 

  while (attemptsMade < maxAttempts) {
    if (runContext?.isCancelled) {
      updateProgress("Quiz solver cancelled (tab closed).", "error");
      return;
    }
    // 1. Get State
    const stateRes = await fetchGraphQL("QueryState", GET_STATE_QUERY, { courseId, itemId });
    const submissionState = stateRes.data.SubmissionState.queryState;
    
    if (submissionState.outcome?.isPassed && submissionState.outcome.earnedGrade >= targetGrade) {
      updateProgress(`Already passed! Current grade: ${(submissionState.outcome.earnedGrade * 100).toFixed(1)}% (Target: ${(targetGrade * 100).toFixed(1)}%)`);
      return;
    } else if (submissionState.outcome?.isPassed) {
      updateProgress(`Passed, but grade ${(submissionState.outcome.earnedGrade * 100).toFixed(1)}% is below target ${(targetGrade * 100).toFixed(1)}%. Retrying...`);
    }
    
    const allowed = submissionState.allowedAction;
    if (allowed === "START_NEW_ATTEMPT") {
      await fetchGraphQL("Submission_StartAttempt", INITIATE_ATTEMPT_QUERY, { courseId, itemId });
      continue;
    } else if (allowed === "RESUME_DRAFT") {
      updateProgress("Resuming draft.");
    } else if (allowed === null) {
      if (submissionState.outcome?.isPassed) return;
      throw new Error("No more attempts remaining.");
    }

    // 2. Retrieve Questions
    const draft = submissionState.attempts.inProgressAttempt;
    const attemptId = draft.id;
    const draftId = draft.draft.id;
    const parts = draft.draft.parts;
    
    let answerResponses = [];
    let unsolvedQuestions = {};

    const QTYPE_MAP = {
      "Submission_MultipleChoiceQuestion": "MULTIPLE_CHOICE",
      "Submission_CheckboxQuestion": "CHECKBOX",
      "Submission_CheckboxReflectQuestion": "CHECKBOX_REFLECT",
      "Submission_TextReflectQuestion": "TEXT_REFLECT",
      "Submission_NumericQuestion": "NUMERIC",
      "Submission_PlainTextQuestion": "PLAIN_TEXT",
      "Submission_TextExactMatchQuestion": "TEXT_EXACT_MATCH",
      "Submission_RegexQuestion": "REGEX",
      "Submission_FileUploadQuestion": "FILE_UPLOAD",
      "Submission_UrlQuestion": "URL",
      "Submission_CodeExpressionQuestion": "CODE_EXPRESSION",
      "Submission_MathQuestion": "MATH",
      "Submission_RichTextQuestion": "RICH_TEXT",
      "Submission_WidgetQuestion": "WIDGET",
      "Submission_MultipleFillableBlanksQuestion": "MULTIPLE_FILLABLE_BLANKS"
    };
    
    for (const part of parts) {
      if (part.__typename === "Submission_TextBlock") {
        continue;
      }

      const qTypeStr = QTYPE_MAP[part.__typename];
      if (!qTypeStr) {
        throw new Error(`Unsupported question type encountered: ${part.__typename}`);
      }

      const partId = part.partId;
      if (!questionsData[partId]) questionsData[partId] = { Options: [] };
      const qd = questionsData[partId];
      
      const prompt = part.questionSchema.prompt?.cmlValue || "";
      const schemaOptions = part.questionSchema.options || [];
      const options = schemaOptions.map((opt, idx) => {
        const val = opt.display.cmlValue;
        const existing = qd.Options.find(o => o.value === val);
        return {
          original_id: opt.optionId,
          option_id: `opt_${idx + 1}`,
          value: stripHtmlTags(val),
          correct: existing ? existing.correct : null
        };
      });
      qd.Options = options;
      qd.Type = qTypeStr;
      qd.Question = stripHtmlTags(prompt);

      if (TEXT_ANSWER_TYPES.has(qTypeStr)) {
        if (qd.correct_answer) {
          const agent = getAgentForType(qTypeStr);
          answerResponses.push(agent.formatPayload(partId, qTypeStr, null, qd.correct_answer));
        } else {
          unsolvedQuestions[partId] = { Question: prompt, Options: [], Type: qTypeStr };
          if (qd.wrong_attempts) unsolvedQuestions[partId].previous_attempts = qd.wrong_attempts;
        }
      } else if (qTypeStr === "MULTIPLE_CHOICE") {
        const knownCorrect = options.find(o => o.correct === true);
        if (knownCorrect) {
          const agent = getAgentForType(qTypeStr);
          answerResponses.push(agent.formatPayload(partId, qTypeStr, [knownCorrect.option_id]));
          continue;
        }
        const filtered = options.filter(o => o.correct !== false);
        if (filtered.length === 1) {
          const agent = getAgentForType(qTypeStr);
          answerResponses.push(agent.formatPayload(partId, qTypeStr, [filtered[0].option_id]));
          continue;
        }
        unsolvedQuestions[partId] = { Question: prompt, Options: filtered, Type: qTypeStr };
      } else if (qTypeStr === "CHECKBOX" || qTypeStr === "CHECKBOX_REFLECT") {
        const allResolved = options.every(o => o.correct !== null);
        if (allResolved) {
          const correctIds = options.filter(o => o.correct === true).map(o => o.option_id);
          const agent = getAgentForType(qTypeStr);
          answerResponses.push(agent.formatPayload(partId, qTypeStr, correctIds));
          continue;
        }
        const filtered = options.filter(o => o.correct !== false);
        unsolvedQuestions[partId] = { Question: prompt, Options: filtered, Type: qTypeStr };
      }
    }

    if (Object.keys(unsolvedQuestions).length > 0) {
      updateProgress("Calling LLM for unsolved questions...");
      
      let domainGroups = {};
      for (const [qid, q] of Object.entries(unsolvedQuestions)) {
        const agent = getAgentForType(q.Type);
        const domain = agent.domain;
        if (!domainGroups[domain]) {
          domainGroups[domain] = { agent: agent, questions: {} };
        }
        domainGroups[domain].questions[qid] = q;
      }

      for (const [domain, groupData] of Object.entries(domainGroups)) {
        let domainQuestions = groupData.questions;
        let reflection = getReflectionPrompt(domainQuestions);
        let customPrompt = groupData.agent.buildPrompt(domainQuestions, reflection);
        
        const llmResult = await callLLM(domainQuestions, settings, customPrompt);
        
        if (!llmResult || !llmResult.responses || llmResult.responses.length === 0) {
          throw new Error(`LLM returned an empty or invalid response format for domain ${domain}.`);
        }
        
        for (const ans of llmResult.responses) {
          let ansType = domainQuestions[ans.question_id].Type;
          let agent = getAgentForType(ansType);
          
          let { chosen, answer } = agent.postProcess(ansType, ans.chosen, ans.answer, domainQuestions, ans.question_id);
          
          answerResponses.push(agent.formatPayload(ans.question_id, ansType, chosen, answer));
        }
      }
    } else {
      updateProgress("All questions answered via local cache.");
    }

    // Ensure all draft elements are answered, fallback to blank response if omitted by LLM
    const answeredIds = new Set(answerResponses.map(r => r.questionId));
    for (const part of parts) {
      if (part.__typename === "Submission_TextBlock" || !part.partId) continue;
      const partId = part.partId;
      const qTypeStr = QTYPE_MAP[part.__typename];
      if (qTypeStr && !answeredIds.has(partId)) {
        console.warn(`[Skipera Solver] LLM did not answer ${partId} (${qTypeStr}). Sending blank fallback response.`);
        const agent = getAgentForType(qTypeStr);
        try {
          answerResponses.push(agent.formatPayload(partId, qTypeStr, [], ""));
        } catch (e) {
          console.error(`Could not format blank payload for ${partId}:`, e);
        }
      }
    }

    // 3. Save Responses
    console.log("[Skipera Solver] Saving answer responses payload:", JSON.stringify(answerResponses, null, 2));
    await fetchGraphQL("Submission_SaveResponses", SAVE_RESPONSES_QUERY, {
      input: { courseId, itemId, attemptId, questionResponses: answerResponses }
    });

    // 4. Submit Draft
    await fetchGraphQL("Submission_SubmitLatestDraft", SUBMIT_DRAFT_QUERY, {
      input: { courseId, itemId, submissionId: draftId }
    });

    // 5. Wait & Get Feedback
    await delay(5000);
    const fbRes = await fetchGraphQL("AssignmentFeedback", ASSIGNMENT_FEEDBACK_QUERY, { courseId, itemId });
    
    const feedbackData = fbRes?.data?.SubmissionState?.queryState?.feedback;
    if (feedbackData) {
      const outcome = feedbackData.outcome || {};
      const latestScore = outcome.latestScore || 0;
      const maxScore = outcome.maxScore || 1;
      const earnedGrade = latestScore / maxScore;
      
      updateProgress(`Received feedback. Earned grade: ${(earnedGrade * 100).toFixed(1)}% | Target grade: ${(targetGrade * 100).toFixed(1)}%`);
      
      if (earnedGrade >= targetGrade) {
        updateProgress("Passed with target grade!");
        return;
      }
      
      if (feedbackData.parts) {
        for (const fPart of feedbackData.parts) {
        const partId = fPart.partId;
        const qd = questionsData[partId];
        if (!qd) continue;

        const isCorrect = fPart.feedback?.correctness === "CORRECT";
        const submitted = answerResponses.find(r => r.questionId === partId);
        
        if (!isCorrect && submitted) {
          qd.wrong_attempts = qd.wrong_attempts || [];
          let chosen = null;
          if (qd.Type === "CHECKBOX" || qd.Type === "CHECKBOX_REFLECT") {
            chosen = submitted.questionResponse.checkboxResponse?.chosen || [];
          } else if (qd.Type === "MULTIPLE_CHOICE") {
            const mChosen = submitted.questionResponse.multipleChoiceResponse?.chosen;
            chosen = mChosen ? [mChosen] : [];
          } else {
            const resKeys = Object.keys(submitted.questionResponse);
            if (resKeys.length > 0) {
               const valKeys = Object.keys(submitted.questionResponse[resKeys[0]]);
               if (valKeys.length > 0) chosen = submitted.questionResponse[resKeys[0]][valKeys[0]];
            }
          }
          
          let mappedChosen = chosen;
          if (Array.isArray(chosen) && ["MULTIPLE_CHOICE", "CHECKBOX", "CHECKBOX_REFLECT"].includes(qd.Type)) {
            mappedChosen = [];
            for (let c of chosen) {
              const wrongOpt = qd.Options.find(o => o.option_id === c || o.original_id === c);
              if (wrongOpt) {
                mappedChosen.push(wrongOpt.option_id);
                // For multiple choice, mark the single chosen option as definitely wrong
                if (qd.Type === "MULTIPLE_CHOICE" && chosen.length === 1) {
                  wrongOpt.correct = false;
                }
              } else {
                mappedChosen.push(c);
              }
            }
          }
          if (mappedChosen) qd.wrong_attempts.push(mappedChosen);
        } else if (isCorrect && submitted) {
          // If the question is correct, cache the correct answer in case we need to retry the whole quiz
          if (qd.Type === "CHECKBOX") {
             const chosen = submitted.questionResponse.checkboxResponse?.chosen || [];
             for (const opt of qd.Options) opt.correct = chosen.includes(opt.option_id) || chosen.includes(opt.original_id);
          } else if (qd.Type === "MULTIPLE_CHOICE") {
             const mChosen = submitted.questionResponse.multipleChoiceResponse?.chosen;
             for (const opt of qd.Options) opt.correct = (opt.option_id === mChosen || opt.original_id === mChosen);
          } else {
             const resKeys = Object.keys(submitted.questionResponse);
             if (resKeys.length > 0) {
               const valKeys = Object.keys(submitted.questionResponse[resKeys[0]]);
               if (valKeys.length > 0) qd.correct_answer = submitted.questionResponse[resKeys[0]][valKeys[0]];
             }
          }
        }
      }
    }
    }
    
    attemptsMade++;
  }
  
  // If we exit the loop without passing
  throw new Error(`Failed to pass after ${maxAttempts} attempts.`);
  
  } catch (err) {
    updateProgress(`ERROR: ${err.message}`);
    throw err;
  }
}
