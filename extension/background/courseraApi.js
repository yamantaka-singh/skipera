// courseraApi.js
// Handles all Coursera API interactions for the background orchestrator.

const BASE_URL = "https://www.coursera.org/api/";

/**
 * Gets the CSRF token from the browser cookies for coursera.org.
 */
export async function getCsrfToken() {
  return new Promise((resolve) => {
    chrome.cookies.getAll({ domain: "coursera.org" }, (cookies) => {
      const csrf = cookies.find(c => c.name.toLowerCase() === "csrf3-token");
      resolve(csrf ? csrf.value : null);
    });
  });
}

/**
 * Helper to make authenticated requests to Coursera API.
 */
export async function fetchCoursera(endpoint, options = {}) {
  const token = await getCsrfToken();
  const headers = {
    ...options.headers,
    "X-CSRF3-Token": token,
  };
  
  // Only add Content-Type if we're sending a body and it's not already set
  if (options.body && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }

  const url = (endpoint.startsWith("http") || endpoint.startsWith("/")) 
    ? endpoint 
    : `${BASE_URL}${endpoint}`;

  const res = await fetch(url, {
    credentials: "include",
    ...options,
    headers
  });
  return res;
}

export async function getUserId() {
  const res = await fetchCoursera("adminUserPermissions.v1?q=my");
  if (!res.ok) return null;
  const data = await res.json();
  return data.elements?.[0]?.id || null;
}

export async function getCourseMaterials(courseSlug) {
  const params = new URLSearchParams({
    q: "slug",
    slug: courseSlug,
    includes: "modules,lessons,passableItemGroups,passableItemGroupChoices,passableLessonElements,items,tracks,gradePolicy,gradingParameters,embeddedContentMapping",
    fields: "moduleIds,onDemandCourseMaterialModules.v1(name,slug,description,timeCommitment,lessonIds,optional,learningObjectives),onDemandCourseMaterialLessons.v1(name,slug,timeCommitment,elementIds,optional,trackId),onDemandCourseMaterialPassableItemGroups.v1(requiredPassedCount,passableItemGroupChoiceIds,trackId),onDemandCourseMaterialPassableItemGroupChoices.v1(name,description,itemIds),onDemandCourseMaterialPassableLessonElements.v1(gradingWeight,isRequiredForPassing),onDemandCourseMaterialItems.v2(name,originalName,slug,timeCommitment,contentSummary,isLocked,lockableByItem,itemLockedReasonCode,trackId,lockedStatus,itemLockSummary,customDisplayTypenameOverride),onDemandCourseMaterialTracks.v1(passablesCount),onDemandGradingParameters.v1(gradedAssignmentGroups),contentAtomRelations.v1(embeddedContentSourceCourseId,subContainerId)",
    showLockedItems: "true"
  });

  const res = await fetchCoursera(`onDemandCourseMaterials.v2/?${params.toString()}`);
  if (!res.ok) throw new Error("Failed to fetch course materials");
  return await res.json();
}

export async function getCompletedItems(userId, courseId) {
  const res = await fetchCoursera(`onDemandCoursesProgress.v1/${userId}~${courseId}?fields=gradedAssignmentGroupProgress`);
  if (!res.ok) return new Set();
  
  const data = await res.json();
  const completed = new Set();
  
  const elements = data.elements || [];
  if (elements.length > 0) {
    const items = elements[0].items || {};
    for (const [itemId, progress] of Object.entries(items)) {
      if (progress.progressState === "Completed") {
        completed.add(itemId);
      }
    }
  }
  return completed;
}

// --- ITEM COMPLETION HANDLERS ---

export async function getVideoMetadata(courseId, itemId) {
  const params = new URLSearchParams({
    includes: "video",
    fields: "disableSkippingForward,startMs,endMs"
  });
  const res = await fetchCoursera(`onDemandLectureVideos.v1/${courseId}~${itemId}?${params.toString()}`);
  const data = await res.json();
  return {
    canSkip: !data.elements[0].disableSkippingForward,
    trackingId: data.linked["onDemandVideos.v1"][0].id
  };
}

export async function watchVideo(userId, courseSlug, courseId, item, metadata) {
  const startUrl = `opencourse.v1/user/${userId}/course/${courseSlug}/item/${item.id}/lecture/videoEvents/play?autoEnroll=false`;
  const endUrl = `opencourse.v1/user/${userId}/course/${courseSlug}/item/${item.id}/lecture/videoEvents/ended?autoEnroll=false`;
  
  if (!metadata.canSkip) {
    await fetchCoursera(startUrl, { method: "POST", body: '{"contentRequestBody":{}}' });
    
    // Update progress
    await fetchCoursera(`onDemandVideoProgresses.v1/${userId}~${courseId}~${metadata.trackingId}`, {
      method: "PUT",
      body: JSON.stringify({
        videoProgressId: `${userId}~${courseId}~${metadata.trackingId}`,
        viewedUpTo: item.timeCommitment + 2000
      })
    });
  }
  
  // End item (can skip calls this directly)
  await fetchCoursera(endUrl, { method: "POST", body: '{"contentRequestBody":{}}' });
  return true;
}

export async function skipLecture(userId, courseSlug, courseId, item) {
  try {
    const meta = await getVideoMetadata(courseId, item.id);
    return await watchVideo(userId, courseSlug, courseId, item, meta);
  } catch {
    const endUrl = `opencourse.v1/user/${userId}/course/${courseSlug}/item/${item.id}/lecture/videoEvents/ended?autoEnroll=false`;
    const res = await fetchCoursera(endUrl, { method: "POST", body: '{"contentRequestBody":{}}' });
    return res.ok;
  }
}

export async function readSupplement(userId, courseId, itemId) {
  const res = await fetchCoursera("onDemandSupplementCompletions.v1", {
    method: "POST",
    body: JSON.stringify({
      courseId,
      itemId,
      userId: parseInt(userId)
    })
  });
  const text = await res.text();
  return text.includes("Completed");
}

export async function completeWidget(userId, courseId, itemId) {
  const res = await fetchCoursera(`onDemandWidgetSessions.v1/${userId}~${courseId}~${itemId}?fields=session,sessionId`);
  if (!res.ok) return false;
  
  const data = await res.json();
  const sessionId = data.elements?.[0]?.sessionId;
  if (!sessionId) return false;

  const putRes = await fetchCoursera(`onDemandWidgetProgress.v1/${userId}~${courseId}~${itemId}`, {
    method: "PUT",
    body: JSON.stringify({
      sessionId,
      progressState: "Completed"
    })
  });
  return putRes.ok;
}

export async function completeLti(userId, courseId, itemId) {
  const res = await fetchCoursera("rest/v1/lti/ungradedLaunches", {
    method: "POST",
    body: JSON.stringify({
      courseId,
      itemId,
      learnerId: parseInt(userId),
      markItemCompleted: true
    })
  });
  return res.ok;
}

export async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Determines whether a course item is a graded assignment/exam.
 */
export function isGradedItem(item, materials) {
  if (!item) return false;
  const itemId = item.id;
  const linked = materials?.linked || {};

  // 1. passableItemGroupChoices (primary indicator of graded items)
  const choices = linked["onDemandCourseMaterialPassableItemGroupChoices.v1"];
  if (choices) {
    const choiceList = Array.isArray(choices) ? choices : Object.values(choices);
    for (const choice of choiceList) {
      if (choice?.itemIds && Array.isArray(choice.itemIds) && choice.itemIds.includes(itemId)) {
        return true;
      }
    }
  }

  // 2. gradedAssignmentGroups
  const params = linked["onDemandGradingParameters.v1"];
  if (params) {
    const paramList = Array.isArray(params) ? params : Object.values(params);
    for (const param of paramList) {
      const rawGroups = param?.gradedAssignmentGroups;
      if (rawGroups) {
        const groups = Array.isArray(rawGroups) ? rawGroups : (typeof rawGroups === "object" ? Object.values(rawGroups) : []);
        for (const group of groups) {
          if (group && typeof group === "object") {
            const itemIds = group.itemIds;
            if (Array.isArray(itemIds) && itemIds.includes(itemId)) {
              return true;
            }
          }
        }
      }
    }
  }

  // 3. passableLessonElements
  const elements = linked["onDemandCourseMaterialPassableLessonElements.v1"];
  if (elements) {
    const elementList = Array.isArray(elements) ? elements : Object.values(elements);
    for (const elem of elementList) {
      const elemId = elem?.id || "";
      const lastId = elemId.includes("~") ? elemId.split("~").pop() : elemId;
      if (lastId === itemId && (elem?.gradingWeight > 0 || elem?.isRequiredForPassing)) {
        return true;
      }
    }
  }

  // 4. Content summary & item flags
  const cs = item.contentSummary || {};
  if (cs.isGraded === true || item.isGraded === true) return true;

  const type = cs.typeName || "";
  if (["gradedAssignment", "exam", "staffGraded", "phasedPeer", "gradedPeer", "gradedProgramming", "closedAssessment"].includes(type)) {
    return true;
  }

  const name = (item.name || "").toLowerCase();
  if ((name.includes("graded") || name.includes("exam") || name.includes("final")) && !name.startsWith("practice")) {
    return true;
  }

  return false;
}

/**
 * Determines whether a course item is a practice/ungraded activity or formative quiz.
 */
export function isPracticeItem(item, materials) {
  if (!item) return false;
  const name = (item.name || "").toLowerCase().trim();
  const type = item.contentSummary?.typeName || "";

  if (name.startsWith("practice") || name.includes("practice quiz") || name.includes("practice assignment")) {
    return true;
  }

  if (["ungradedWidget", "ungradedLti", "coach", "ungradedAssignment"].includes(type)) {
    if (!isGradedItem(item, materials)) {
      return true;
    }
  }

  return false;
}

/**
 * Fetches lightweight context (readings) from the current module to inject into the LLM prompt.
 */
const PER_ITEM_CHARS = 2500;
const TOTAL_CTX_CHARS = 10000; // ponytail: bigger = better recall but slower LLM prefill; 10k is the sweet spot
const _moduleContextCache = new Map(); // moduleKey -> built context string

async function fetchSupplementText(courseId, itemId) {
  const res = await fetchCoursera(`onDemandSupplements.v1/${courseId}~${itemId}?includes=asset&fields=value`);
  if (!res.ok) return "";
  const data = await res.json();
  return (data.elements?.[0]?.value || "").replace(/<[^>]*>?/gm, " ").replace(/\s+/g, " ").trim();
}

// Best-effort video transcript. ponytail: Coursera serves subtitles from its CDN,
// which is not in host_permissions, so this only succeeds when the subtitle URL is
// same-origin (older courses / proxied assets). Fails silently otherwise — add the
// CDN to host_permissions (forces a permission re-prompt) to make it universal.
async function fetchTranscriptText(courseId, itemId) {
  try {
    const res = await fetchCoursera(
      `onDemandLectureVideos.v1/${courseId}~${itemId}?includes=video&fields=onDemandVideos.v1(subtitles,subtitlesTxt)`
    );
    if (!res.ok) return "";
    const video = (await res.json()).linked?.["onDemandVideos.v1"]?.[0] || {};
    const map = video.subtitlesTxt || video.subtitles || {};
    let url = map.en || map["en-US"] || Object.values(map)[0];
    if (!url) return "";
    if (url.startsWith("/")) url = "https://www.coursera.org" + url;
    const txtRes = await fetch(url);
    if (!txtRes.ok) return "";
    return vttToText(await txtRes.text());
  } catch (e) {
    return "";
  }
}

// Strip WEBVTT header, cue numbers, and "00:00:01.000 --> 00:00:04.000" timing
// lines, leaving just the spoken text. Also fine for plain .txt (a no-op then).
export function vttToText(raw) {
  return String(raw || "")
    .replace(/^WEBVTT.*$/im, "")
    .replace(/^\d+\s*$/gm, "")
    .replace(/^[\d:.,]+\s*-->\s*[\d:.,].*$/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

export async function getModuleContext(courseId, currentItemId, materials) {
  try {
    const items = materials?.linked?.["onDemandCourseMaterialItems.v2"] || [];
    const modules = materials?.linked?.["onDemandCourseMaterialModules.v1"] || [];
    const lessons = materials?.linked?.["onDemandCourseMaterialLessons.v1"] || [];

    // Find which module contains this item
    let itemsInModule = [];
    for (const mod of modules) {
      let moduleItems = [];
      const modLessons = lessons.filter(l => (mod.lessonIds || []).includes(l.id));
      for (const les of modLessons) {
        moduleItems.push(...(les.elementIds || []));
      }
      moduleItems = moduleItems.map(id => id.includes("~") ? id.split("~")[1] : id);
      if (moduleItems.includes(currentItemId)) {
        itemsInModule = moduleItems;
        break;
      }
    }
    if (!itemsInModule.length) return "";

    // Cache per module so sibling quizzes / retries don't refetch every transcript.
    const moduleKey = `${courseId}:${itemsInModule[0]}`;
    if (_moduleContextCache.has(moduleKey)) return _moduleContextCache.get(moduleKey);

    // All items before this quiz in the module (readings + lectures), in order.
    const currentIndex = itemsInModule.indexOf(currentItemId);
    const prevIds = itemsInModule.slice(0, currentIndex);

    const blocks = await Promise.all(prevIds.map(async (prevId) => {
      const itemObj = items.find(i => i.id === prevId);
      const type = itemObj?.contentSummary?.typeName;
      try {
        if (type === "supplement") {
          const t = await fetchSupplementText(courseId, prevId);
          return t ? `--- Reading: ${itemObj.name} ---\n${t.slice(0, PER_ITEM_CHARS)}` : null;
        }
        if (type === "lecture") {
          const t = await fetchTranscriptText(courseId, prevId);
          return t ? `--- Lecture: ${itemObj.name} ---\n${t.slice(0, PER_ITEM_CHARS)}` : null;
        }
      } catch (e) {}
      return null;
    }));

    let ctx = "";
    for (const b of blocks.filter(Boolean)) {
      if (ctx.length + b.length > TOTAL_CTX_CHARS) break;
      ctx += (ctx ? "\n\n" : "") + b;
    }
    _moduleContextCache.set(moduleKey, ctx);
    return ctx;
  } catch (err) {
    console.error("Failed to fetch context", err);
    return "";
  }
}

