import { getUserId, getCourseMaterials, getCompletedItems, skipLecture, readSupplement, completeWidget, completeLti, delay, fetchCoursera, isGradedItem, isPracticeItem } from './courseraApi.js';
import { triggerQuizSolver } from './quizSolver.js';
import { callLLMProvider } from './llmProviders.js';
import { updateDashboard } from './dashboardStore.js';

export const activeRuns = new Map(); // tabId -> { courseSlug, isCancelled: false }

export function stopRunForTab(tabId) {
  if (!tabId) return;
  const run = activeRuns.get(tabId);
  if (run) {
    run.isCancelled = true;
    updateDashboard("Process terminated (Tab was closed).", "error", run.courseSlug);
    activeRuns.delete(tabId);
    console.log(`[Skipera] Run terminated for tab ${tabId} (${run.courseSlug})`);
  }
}

async function runConcurrent(items, limit, fn) {
  const results = [];
  const executing = new Set();
  for (const item of items) {
    const p = Promise.resolve().then(() => fn(item));
    results.push(p);
    executing.add(p);
    const clean = () => executing.delete(p);
    p.then(clean, clean);
    if (executing.size >= limit) {
      await Promise.race(executing);
    }
  }
  return Promise.all(results);
}

async function processBatchableItem(item, userId, safeSlug, courseId, updateProgress) {
  const type = item.contentSummary?.typeName;
  if (type === "lecture") {
    const ok = await skipLecture(userId, safeSlug, courseId, item);
    if (ok === false) throw new Error("Could not mark lecture as complete");
    updateProgress(`Completed lecture: ${item.name}`, "complete");
  } else if (type === "supplement") {
    const ok = await readSupplement(userId, courseId, item.id);
    if (ok === false) throw new Error("Could not mark supplement as read");
    updateProgress(`Completed supplement: ${item.name}`, "complete");
  } else if (type === "widget" || type === "gradedWidget" || type === "ungradedWidget") {
    const ok = await completeWidget(userId, courseId, item.id);
    if (ok === false) throw new Error("Could not complete widget");
    updateProgress(`Completed widget: ${item.name}`, "complete");
  } else if (type === "lti" || type === "gradedLti" || type === "ungradedLti") {
    const ok = await completeLti(userId, courseId, item.id);
    if (ok === false) throw new Error("Could not launch LTI item");
    updateProgress(`Completed LTI: ${item.name}`, "complete");
  }
}

export async function runFullCourse(courseSlug, settings, tabId) {
  const safeSlug = courseSlug || "default";
  
  if (tabId && activeRuns.has(tabId) && !activeRuns.get(tabId).isCancelled) {
    return { status: "Already running for this tab" };
  }

  const provider = settings?.provider || "nvidia";
  const apiKeyStr = settings?.apiKey || "";
  const isAiSolver = !settings?.videosOnly && apiKeyStr.trim().length > 0;
  
  // NVIDIA NIM Concurrency Shield: Max 3 concurrent runs per API key across all open tabs
  if (provider === "nvidia" && isAiSolver) {
    const keyList = apiKeyStr.split(",").map(k => k.trim()).filter(k => k);
    const maxAllowed = Math.max(1, keyList.length) * 3;
    let currentNvidiaRuns = 0;
    for (const [tId, run] of activeRuns.entries()) {
      if (!run.isCancelled && (run.provider || "nvidia") === "nvidia" && run.isAiSolver) {
        currentNvidiaRuns++;
      }
    }
    
    if (currentNvidiaRuns >= maxAllowed) {
      const msg = `NVIDIA Concurrency Shield: ${currentNvidiaRuns}/${maxAllowed} concurrent course runs active. NVIDIA NIM permits max 3 concurrent tasks per API key. Please wait for an active tab to finish or add additional comma-separated API keys.`;
      updateDashboard(msg, "error", safeSlug);
      return { status: "Error", error: msg };
    }
  }
  
  const runContext = { courseSlug: safeSlug, provider, isCancelled: false, isAiSolver };
  if (tabId) {
    activeRuns.set(tabId, runContext);
  }
  
  const updateProgress = (msg, overrideType) => {
    let type = overrideType || "info";
    if (!overrideType) {
      if (msg.includes("Skipping") || msg.includes("No unlocked")) type = "skip";
      else if (msg.includes("ERROR") || msg.includes("Failed") || msg.includes("Error")) type = "error";
      else if (msg.includes("Complete") || msg.includes("successfully") || msg.includes("Passed")) type = "complete";
      else if (msg.includes("Starting") || msg.includes("Processing") || msg.includes("Triggering") || msg.includes("Fast-forwarding")) type = "active";
    }
    updateDashboard(msg, type, safeSlug);
  };
  
  try {
    const userId = await getUserId();
    if (!userId) throw new Error("Could not fetch User ID. Are you logged in?");
    
    updateProgress(`Starting run for course: ${safeSlug}`);
    const initialMaterials = await getCourseMaterials(safeSlug);
    const courseId = initialMaterials.elements[0].id;
    
    let loopCount = 0;
    const skippedItems = new Set();
    const itemAttempts = new Map();
    const batchableTypes = new Set(["lecture", "supplement", "widget", "gradedWidget", "ungradedWidget", "lti", "gradedLti", "ungradedLti"]);
    const quizTypes = new Set(["exam", "quiz", "assignment", "closedAssessment", "programming", "gradedProgramming", "staffGraded", "ungradedAssignment"]);
    // Peer-review assignments use a phased submit/review/grade flow that the SubmissionState.queryState
    // API rejects ("Unsupported Assignment Type ... phasedPeer"). Not auto-solvable — always skipped.
    const peerTypes = new Set(["phasedPeer", "gradedPeer"]);

    while (loopCount < 100) {
      if (tabId && runContext.isCancelled) {
        updateProgress("Process terminated (tab closed).", "error");
        break;
      }
      
      loopCount++;
      const completedIds = await getCompletedItems(userId, courseId);
      const materials = await getCourseMaterials(safeSlug);
      
      const items = materials.linked["onDemandCourseMaterialItems.v2"] || [];
      const uncompleted = items.filter(item => !completedIds.has(item.id) && !skippedItems.has(item.id));
      
      if (items.length > 0) {
        const rate = Math.floor((completedIds.size / items.length) * 100);
        updateDashboard(rate, "completionRate", safeSlug);
      }
      
      updateProgress(`Found ${uncompleted.length} uncompleted items.`);
      if (uncompleted.length === 0) {
        updateProgress("Course Complete!", "complete");
        break;
      }
      
      const unlocked = uncompleted.filter(item => !item.isLocked);
      if (unlocked.length === 0) {
        updateProgress("Remaining items are locked or waiting. Stopping.", "skip");
        break;
      }

      // Automatically skip items that have been attempted 2+ times without Coursera registering completion
      for (const item of unlocked) {
        const attempts = itemAttempts.get(item.id) || 0;
        if (attempts >= 2) {
          skippedItems.add(item.id);
          updateProgress(`Skipping uncompletable item: ${item.name}`, "skip");
        }
      }

      // 1. Graded-only mode: skip everything except graded items
      if (settings?.gradedOnly) {
        for (const item of unlocked) {
          if (!isGradedItem(item, materials)) {
            skippedItems.add(item.id);
            updateProgress(`Skipping non-graded item: ${item.name}`, "skip");
          }
        }
      }
      // 2. Fast-forward mode (videos only / no API key): skip quiz/discussion/AI items
      else if (settings?.videosOnly || !settings?.apiKey?.trim()) {
        for (const item of unlocked) {
          const type = item.contentSummary?.typeName;
          if (quizTypes.has(type) || peerTypes.has(type) || type === "discussionPrompt" || ["plugin", "notebook"].includes(type)) {
            skippedItems.add(item.id);
            updateProgress(`Skipping ${item.name} (${type}) in fast-forward mode`, "skip");
          }
        }
      }
      // 3. Skip practice mode (default when solving quizzes): skip practice quizzes and ungraded activities
      else if (settings?.skipPractice !== false) {
        for (const item of unlocked) {
          if (isPracticeItem(item, materials)) {
            skippedItems.add(item.id);
            updateProgress(`Skipping practice item: ${item.name}`, "skip");
          }
        }
      }

      const batchableItems = unlocked.filter(item => batchableTypes.has(item.contentSummary?.typeName) && !skippedItems.has(item.id));
      const sequentialItems = unlocked.filter(item => !batchableTypes.has(item.contentSummary?.typeName) && !skippedItems.has(item.id));

      if (batchableItems.length > 0) {
        updateProgress(`Fast-forwarding ${batchableItems.length} videos & reading items in parallel...`, "active");
        
        await runConcurrent(batchableItems, 10, async (item) => {
          if (tabId && runContext.isCancelled) return;
          itemAttempts.set(item.id, (itemAttempts.get(item.id) || 0) + 1);
          try {
            await processBatchableItem(item, userId, safeSlug, courseId, updateProgress);
          } catch (e) {
            updateProgress(`Failed to process item ${item.name}: ${e.message}`, "error");
            skippedItems.add(item.id);
          }
        });
        
        await delay(200);
        continue;
      }

      if (sequentialItems.length > 0) {
        const item = sequentialItems[0];
        if (tabId && runContext.isCancelled) break;
        const type = item.contentSummary?.typeName;

        itemAttempts.set(item.id, (itemAttempts.get(item.id) || 0) + 1);
        updateProgress(`Processing item: ${item.name} (${type})`);
        try {
          if (quizTypes.has(type)) {
            updateProgress(`Triggering quiz solver for ${item.name}`);
            await triggerQuizSolver(courseId, item.id, settings, tabId, safeSlug, runContext, materials);
            updateProgress(`Completed quiz item: ${item.name}`, "complete");
          } else if (type === "discussionPrompt") {
            await solveDiscussion(courseId, item.id, settings, tabId);
            updateProgress(`Completed discussion: ${item.name}`, "complete");
          } else if (peerTypes.has(type)) {
            updateProgress(`Skipping peer review (complete manually): ${item.name}`, "skip");
            skippedItems.add(item.id);
          } else {
            updateProgress(`Skipping unsupported item: ${item.name} (${type})`, "skip");
            skippedItems.add(item.id);
          }
        } catch (e) {
          updateProgress(`Failed to process item ${item.name}: ${e.message}`, "error");
          skippedItems.add(item.id);
        }
        await delay(200);
        continue;
      }

      break;
    }
  } catch (err) {
    console.error(err);
    updateDashboard(`Run failed: ${err.message}`, "error", safeSlug);
    if (tabId) activeRuns.delete(tabId);
    throw err;
  }
  
  if (tabId) activeRuns.delete(tabId);
  return { status: "Finished" };
}

async function solveDiscussion(courseId, itemId, settings, tabId) {
  const updateProgress = (msg) => {
    if (tabId) {
      chrome.tabs.sendMessage(tabId, { action: "UPDATE_PROGRESS", message: msg }).catch(() => {});
    }
    console.log(msg);
  };
  
  try {
    updateProgress("Fetching discussion prompt...");
    const userId = await getUserId();
    if (!userId) throw new Error("Could not fetch User ID for discussion. Are you logged in?");
    
    const url = `onDemandDiscussionPrompts.v1/${userId}~${courseId}~${itemId}?fields=onDemandDiscussionPromptQuestions.v1(content),promptType,question&includes=question`;
    
    const res = await fetchCoursera(url);
    if (!res.ok) throw new Error(`Failed to fetch discussion prompt: ${res.status}`);
    const data = await res.json();
    
    if (!data.elements || data.elements.length === 0) {
      throw new Error("Could not fetch discussion prompt details.");
    }
    
    const element = data.elements[0];
    const questions = (data.linked && data.linked["onDemandDiscussionPromptQuestions.v1"]) ? data.linked["onDemandDiscussionPromptQuestions.v1"] : [];
    if (questions.length === 0) {
      throw new Error("No discussion questions found.");
    }
    
    const question = questions[0];
    const title = question.content?.question || "";
    const detailsHtml = question.content?.details?.definition?.value || "";
    // strip HTML
    const details = detailsHtml.replace(/<[^>]*>?/gm, '');
    
    let forumQuestionId = element.promptType?.definition?.courseItemForumQuestionId || question.id;
    if (!forumQuestionId) throw new Error("Could not determine courseForumQuestionId");
    
    let finalForumQuestionId = "";
    const parts = forumQuestionId.split("~");
    if (parts.length === 4 && parts[1] === courseId) {
      finalForumQuestionId = `${parts[1]}~${parts[3]}`;
    } else if (parts.length === 3 && parts[0] === courseId) {
      finalForumQuestionId = `${parts[0]}~${parts[2]}`;
    } else if (parts.length === 2 && parts[0] === courseId) {
      finalForumQuestionId = forumQuestionId;
    } else {
      finalForumQuestionId = forumQuestionId; // fallback
    }
    
    updateProgress("Asking LLM for a discussion reply...");
    
    const systemPrompt = `Write a concise Coursera discussion reply for the provided prompt. Answer every question directly, use a natural first-person tone, and keep it concrete. Never return fill-in-the-blank templates, bracketed placeholders. Return only the discussion reply text.`;
    
    const userPrompt = `Discussion title:\n${title}\n\nDiscussion prompt:\n${details}\n\nWrite the reply I should post. Return it inside the "answer" field of the JSON response schema.`;

    const keys = settings.apiKey.split(",").map(k => k.trim());
    const llmResult = await callLLMProvider(settings.provider, keys, settings.modelName, systemPrompt, userPrompt);
    
    let answerText = "";
    if (llmResult && llmResult.responses && llmResult.responses.length > 0) {
       answerText = llmResult.responses[0].answer;
    }
    
    if (!answerText) {
      throw new Error("LLM returned empty answer for discussion prompt");
    }
    
    updateProgress("Submitting discussion answer...");
    
    // To submit, we need to POST to onDemandCourseForumAnswers.v1
    const submitUrl = `onDemandCourseForumAnswers.v1/?fields=content,forumQuestionId&includes=profiles`;
    
    // Convert to CML format
    const lines = answerText.split("\n").filter(line => line.trim().length > 0);
    const cmlValue = "<co-content>" + lines.map(line => `<text>${line}</text>`).join("") + "</co-content>";
    
    const postBody = {
      content: {
        typeName: "cml",
        definition: {
          dtdId: "discussion/1",
          value: cmlValue
        }
      },
      courseForumQuestionId: finalForumQuestionId
    };
    
    const submitRes = await fetchCoursera(submitUrl, {
      method: "POST",
      body: JSON.stringify(postBody)
    });
    
    if (submitRes.ok) {
       updateProgress("Discussion prompt answered successfully!");
    } else {
       const errText = await submitRes.text();
       throw new Error(`Failed to submit discussion answer: ${submitRes.status} ${errText}`);
    }
    
  } catch (err) {
    updateProgress(`ERROR in discussion: ${err.message}`);
    throw err;
  }
}
