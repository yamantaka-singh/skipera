import click
import httpx
from concurrent.futures import ThreadPoolExecutor, as_completed
from .config import fetch_browser_cookies, CONFIG_FILE, DEFAULT_CONFIG, BASE_URL, HEADERS, COOKIES
import json
from loguru import logger
from .assessment.solver import GradedSolver
from .discussion.solver import DiscussionPromptSolver
from .coach.solver import CoachSolver
from .watcher.watch import Watcher
from .session_utils import get_csrf_headers


class Skipera(object):
    def __init__(self, course: str, llm: bool, skip_practice: bool = False, graded_only: bool = False):
        self.user_id = None
        self.course_id = None
        self.base_url = BASE_URL
        self.session = httpx.Client(timeout=60.0, follow_redirects=True)
        self.session.headers.update(HEADERS)
        self.session.cookies.update(COOKIES)
        self.course = course
        self.llm = llm
        self.skip_practice = skip_practice or getattr(config, "SKIP_PRACTICE", False)
        self.graded_only = graded_only or getattr(config, "GRADED_ONLY", False)
        self.failed_items = set()
        self.skipped_items = set()
        self._graded_item_ids = None
        if not self.get_userid():
            self.refresh_cookies()
            if not self.get_userid():
                logger.error(
                    "Cookies are invalid. Log into Coursera in your browser, close it, and retry.")
                raise SystemExit

    def refresh_cookies(self):
        logger.warning("Session expired — re-fetching cookies from browser...")
        cookies = fetch_browser_cookies()
        if not cookies:
            return
        self.session.cookies.clear()
        self.session.cookies.update(cookies)
        cfg = json.loads(CONFIG_FILE.read_text()
                         ) if CONFIG_FILE.exists() else DEFAULT_CONFIG.copy()
        cfg["cookies"] = cookies
        CONFIG_FILE.write_text(json.dumps(cfg, indent=2))

    def get_userid(self) -> bool:
        r = self.session.get(
            self.base_url + "adminUserPermissions.v1?q=my").json()
        try:
            self.user_id = r["elements"][0]["id"]
            logger.info("User ID: " + self.user_id)
        except KeyError:
            if r.get("errorCode"):
                logger.error("Error Encountered: " + r["errorCode"])
            return False
        return True

    def get_graded_item_ids(self, materials_data: dict) -> set[str]:
        graded_ids = set()
        linked = materials_data.get("linked", {})

        # 1. passableItemGroupChoices (primary source of graded items)
        choices = linked.get("onDemandCourseMaterialPassableItemGroupChoices.v1", [])
        choice_list = choices if isinstance(choices, list) else list(choices.values()) if isinstance(choices, dict) else []
        for choice in choice_list:
            if isinstance(choice, dict):
                for item_id in choice.get("itemIds", []):
                    graded_ids.add(item_id)

        # 2. gradedAssignmentGroups in onDemandGradingParameters
        params = linked.get("onDemandGradingParameters.v1", [])
        param_list = params if isinstance(params, list) else list(params.values()) if isinstance(params, dict) else []
        for param in param_list:
            if isinstance(param, dict):
                raw_groups = param.get("gradedAssignmentGroups", [])
                group_list = raw_groups if isinstance(raw_groups, list) else list(raw_groups.values()) if isinstance(raw_groups, dict) else []
                for group in group_list:
                    if isinstance(group, dict):
                        for item_id in group.get("itemIds", []):
                            graded_ids.add(item_id)

        # 3. passableLessonElements
        elements = linked.get("onDemandCourseMaterialPassableLessonElements.v1", [])
        element_list = elements if isinstance(elements, list) else list(elements.values()) if isinstance(elements, dict) else []
        for elem in element_list:
            if isinstance(elem, dict):
                elem_id = elem.get("id", "")
                item_id = elem_id.split("~")[-1] if "~" in elem_id else elem_id
                if elem.get("gradingWeight", 0) > 0 or elem.get("isRequiredForPassing", False):
                    graded_ids.add(item_id)

        # 4. Item-level flags and explicit graded types
        for item in linked.get("onDemandCourseMaterialItems.v2", []):
            item_id = item.get("id")
            content_summary = item.get("contentSummary", {})
            type_name = content_summary.get("typeName", "")
            if content_summary.get("isGraded") is True or item.get("isGraded") is True:
                graded_ids.add(item_id)
            elif type_name in {"gradedAssignment", "exam", "staffGraded", "phasedPeer", "gradedPeer", "gradedProgramming", "closedAssessment"}:
                graded_ids.add(item_id)

        return graded_ids

    def is_graded_item(self, item: dict, materials_data: dict = None) -> bool:
        item_id = item.get("id")
        if self._graded_item_ids is None and materials_data:
            self._graded_item_ids = self.get_graded_item_ids(materials_data)

        if self._graded_item_ids and item_id in self._graded_item_ids:
            return True

        content_summary = item.get("contentSummary", {})
        type_name = content_summary.get("typeName", "")
        if content_summary.get("isGraded") is True or item.get("isGraded") is True:
            return True

        if type_name in {"gradedAssignment", "exam", "staffGraded", "phasedPeer", "gradedPeer", "gradedProgramming", "closedAssessment"}:
            return True

        name = (item.get("name") or "").lower()
        if ("graded" in name or "exam" in name or "final" in name) and not name.startswith("practice"):
            return True

        return False

    def is_practice_item(self, item: dict, materials_data: dict = None) -> bool:
        name = (item.get("name") or "").lower().strip()
        type_name = item.get("contentSummary", {}).get("typeName", "")

        if name.startswith("practice") or "practice quiz" in name or "practice assignment" in name:
            return True

        if type_name in {"ungradedWidget", "ungradedLti", "coach", "ungradedAssignment"}:
            if not self.is_graded_item(item, materials_data):
                return True

        return False

    def get_course(self) -> None:
        r = self.get_course_materials()
        self.course_id = r["elements"][0]["id"]
        all_items = r["linked"]["onDemandCourseMaterialItems.v2"]
        self._graded_item_ids = self.get_graded_item_ids(r)

        logger.info("Course ID: " + self.course_id)
        logger.info("Number of Modules: " +
                    str(len(r["linked"]["onDemandCourseMaterialModules.v1"])))
        logger.info("Total items: " + str(len(all_items)))

        if self.graded_only:
            logger.info(f"Graded-only mode active: Found {len(self._graded_item_ids)} graded items in course.")
        elif self.skip_practice:
            logger.info("Skip-practice mode active: Practice quizzes and ungraded items will be skipped.")

        self.process_items(all_items)

    def get_course_materials(self) -> dict:
        r = self.session.get(self.base_url + f"onDemandCourseMaterials.v2/", params={
            "q": "slug",
            "slug": self.course,
            "includes": "modules,lessons,passableItemGroups,passableItemGroupChoices,passableLessonElements,items,"
                        "tracks,gradePolicy,gradingParameters,embeddedContentMapping",
            "fields": "moduleIds,onDemandCourseMaterialModules.v1(name,slug,description,timeCommitment,lessonIds,"
                      "optional,learningObjectives),onDemandCourseMaterialLessons.v1(name,slug,timeCommitment,"
                      "elementIds,optional,trackId),onDemandCourseMaterialPassableItemGroups.v1(requiredPassedCount,"
                      "passableItemGroupChoiceIds,trackId),onDemandCourseMaterialPassableItemGroupChoices.v1(name,"
                      "description,itemIds),onDemandCourseMaterialPassableLessonElements.v1(gradingWeight,"
                      "isRequiredForPassing),onDemandCourseMaterialItems.v2(name,originalName,slug,timeCommitment,"
                      "contentSummary,isLocked,lockableByItem,itemLockedReasonCode,trackId,lockedStatus,itemLockSummary,"
                      "customDisplayTypenameOverride),onDemandCourseMaterialTracks.v1(passablesCount),"
                      "onDemandGradingParameters.v1(gradedAssignmentGroups),"
                      "contentAtomRelations.v1(embeddedContentSourceCourseId,subContainerId)",
            "showLockedItems": True
        })

        if r.status_code != 200:
            logger.error("Please check if you are enrolled in the course!")
            raise SystemExit

        return r.json()

    def process_items(self, all_items: list[dict]) -> None:
        total = len(all_items)

        while True:
            completed = self.get_completed_items()

            try:
                fresh_data = self.get_course_materials()
                self._graded_item_ids = self.get_graded_item_ids(fresh_data)
                current_items = fresh_data["linked"]["onDemandCourseMaterialItems.v2"]
            except SystemExit:
                current_items = all_items
                fresh_data = None

            pending_items = [item for item in current_items if item["id"] not in completed]
            if not pending_items:
                logger.info(f"Finished: {total}/{total} completed.")
                break

            unlocked_items = [
                item for item in pending_items 
                if not item.get("isLocked", False) and item["id"] not in self.failed_items and item["id"] not in self.skipped_items
            ]
            if not unlocked_items:
                logger.info(
                    f"Finished: {total - len(pending_items)}/{total} completed, {len(pending_items)} still locked/pending."
                )
                break

            # Filter items based on graded_only or skip_practice
            items_to_process = []
            for item in unlocked_items:
                if self.graded_only and not self.is_graded_item(item, fresh_data):
                    logger.info(f"Skipping non-graded item: {item['name']}")
                    self.skipped_items.add(item["id"])
                elif self.skip_practice and self.is_practice_item(item, fresh_data):
                    logger.info(f"Skipping practice item: {item['name']}")
                    self.skipped_items.add(item["id"])
                else:
                    items_to_process.append(item)

            if not items_to_process:
                continue

            concurrent_items = []
            sequential_items = []
            quiz_and_interactive = {
                "discussionPrompt", "ungradedAssignment", "staffGraded", "phasedPeer",
                "gradedAssignment", "exam", "quiz", "gradedPeer", "programming",
                "gradedProgramming", "closedAssessment"
            }
            for item in items_to_process:
                if item["contentSummary"]["typeName"] not in quiz_and_interactive:
                    concurrent_items.append(item)
                else:
                    sequential_items.append(item)

            if concurrent_items:
                with ThreadPoolExecutor(max_workers=min(10, len(concurrent_items))) as executor:
                    futures = {
                        executor.submit(self.process_item, item): item 
                        for item in concurrent_items
                    }
                    for future in as_completed(futures):
                        item = futures[future]
                        try:
                            success = future.result()
                            if not success:
                                self.failed_items.add(item["id"])
                        except Exception as e:
                            logger.exception(f"Error in processing item: {e}")
                            self.failed_items.add(item["id"])
                continue

            if sequential_items:
                item = sequential_items[0]
                try:
                    success = self.process_item(item)
                    if not success:
                        self.failed_items.add(item["id"])
                except Exception as e:
                    logger.exception(f"Error in processing item: {e}")
                    self.failed_items.add(item["id"])
                continue

    def process_item(self, item: dict) -> bool:
        item_type = item["contentSummary"]["typeName"]
        module_id = item.get('moduleId', 'unknown')
        item_id = item['id']
        logger.info(
            f"[module:{module_id}] [item:{item_id}] Processing {item['name']}")

        quiz_types = {
            "ungradedAssignment", "staffGraded", "gradedAssignment", "exam", "quiz",
            "phasedPeer", "gradedPeer", "programming", "gradedProgramming", "closedAssessment"
        }

        success = False
        if item_type == "lecture":
            success = self.watch_item(item, self.get_video_metadata(item_id))
        elif item_type == "supplement":
            success = self.read_item(item_id)
        elif item_type in quiz_types and self.llm:
            if (self.skip_practice or self.graded_only) and self.is_practice_item(item):
                logger.info(f"[module:{module_id}] [item:{item_id}] Skipping practice quiz {item['name']}")
                return True
            success = GradedSolver(
                self.session, self.course_id, item_id, course_name=self.course, item_name=item.get("name", "")
            ).solve()
        elif item_type == "discussionPrompt" and self.llm:
            if (self.skip_practice or self.graded_only) and self.is_practice_item(item):
                logger.info(f"[module:{module_id}] [item:{item_id}] Skipping practice discussion {item['name']}")
                return True
            success = DiscussionPromptSolver(
                self.session, self.user_id, self.course_id, item_id).solve()
        elif item_type == "coach":
            if (self.skip_practice or self.graded_only) and self.is_practice_item(item):
                logger.info(f"[module:{module_id}] [item:{item_id}] Skipping practice coach {item['name']}")
                return True
            success = CoachSolver(
                self.session, self.user_id, self.course_id, item_id).solve()
        elif item_type == "ungradedWidget":
            if self.graded_only or self.skip_practice:
                logger.info(f"[module:{module_id}] [item:{item_id}] Skipping practice widget {item['name']}")
                return True
            success = self.ungraded_widget_item(item_id)
        elif item_type == "ungradedLti":
            if self.graded_only or self.skip_practice:
                logger.info(f"[module:{module_id}] [item:{item_id}] Skipping practice LTI {item['name']}")
                return True
            success = self.ungraded_lti_item(item_id)
        else:
            logger.warning(
                f"[module:{module_id}] [item:{item_id}] Unknown/skipped item type: {item_type} - skipping.")

        return success

    def get_completed_items(self) -> set[str]:
        r = self.session.get(
            self.base_url +
            f"onDemandCoursesProgress.v1/{self.user_id}~{self.course_id}",
            params={"fields": "gradedAssignmentGroupProgress"}
        )

        if r.status_code != 200:
            logger.debug("Could not fetch course progress.")
            logger.debug(r.text)
            return set()

        data = r.json()
        elements = data.get("elements") or []
        if not elements:
            logger.debug("Course progress response has no elements.")
            return set()

        items = elements[0].get("items", {})
        return {
            item_id
            for item_id, progress in items.items()
            if progress.get("progressState") == "Completed"
        }

    def get_video_metadata(self, item_id: str) -> dict:
        r = self.session.get(self.base_url + f"onDemandLectureVideos.v1/{self.course_id}~{item_id}", params={
            "includes": "video",
            "fields": "disableSkippingForward,startMs,endMs"
        }).json()

        return {"can_skip": not r["elements"][0]["disableSkippingForward"],
                "tracking_id": r["linked"]["onDemandVideos.v1"][0]["id"]}

    def watch_item(self, item: dict, metadata: dict) -> bool:
        watcher = Watcher(self.session, item, metadata,
                          self.user_id, self.course, self.course_id)
        return watcher.watch_item()

    def read_item(self, item_id) -> bool:
        r = self.session.post(self.base_url + "onDemandSupplementCompletions.v1",
                              headers=get_csrf_headers(self.session),
                              json={
                                  "courseId": self.course_id,
                                  "itemId": item_id,
                                  "userId": int(self.user_id)
                              })
        return "Completed" in r.text

    def ungraded_widget_item(self, item_id) -> bool:
        r = self.session.get(
            self.base_url + f"onDemandWidgetSessions.v1/{self.user_id}~{self.course_id}~{item_id}",
            params={"fields": "session,sessionId"}
        )
        if r.status_code != 200:
            logger.error(f"Failed to get session for widget {item_id}: {r.status_code}")
            return False

        try:
            session_id = r.json()["elements"][0]["sessionId"]
        except (KeyError, IndexError):
            logger.error(f"Could not parse sessionId for widget {item_id}")
            return False

        res = self.session.put(
            self.base_url + f"onDemandWidgetProgress.v1/{self.user_id}~{self.course_id}~{item_id}",
            headers=get_csrf_headers(self.session),
            json={
                "sessionId": session_id,
                "progressState": "Completed"
            }
        )
        return 200 <= res.status_code < 300

    def ungraded_lti_item(self, item_id) -> bool:
        r = self.session.post(
            self.base_url + "rest/v1/lti/ungradedLaunches",
            headers=get_csrf_headers(self.session),
            json={
                "courseId": self.course_id,
                "itemId": item_id,
                "learnerId": int(self.user_id),
                "markItemCompleted": True
            }
        )
        return 200 <= r.status_code < 300


@logger.catch
@click.command()
@click.argument('slug')
@click.option('--llm', is_flag=True, help="Whether to use an LLM to solve graded assignments.")
@click.option('--skip-practice', is_flag=True, default=False, help="Skip practice quizzes/assignments and only solve graded items.")
@click.option('--graded-only', '-g', is_flag=True, default=False, help="Only solve graded assignments, skipping all practice and non-graded items.")
def main(slug: str, llm: bool, skip_practice: bool, graded_only: bool) -> None:
    skipera = Skipera(slug, llm, skip_practice=skip_practice, graded_only=graded_only)
    skipera.get_course()

if __name__ == '__main__':
    main()
