import json
import logging
import os
import re
import traceback
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Literal, Optional

from dotenv import load_dotenv

# Load project-root .env before other app imports read os.environ (e.g. Notion).
# override=True: values in .env replace any NOTION_* already set in the shell (avoids stale dashed IDs).
_env_path = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(_env_path, override=True)
print(
    "[NOTION CONFIG] credentials:",
    bool(os.getenv("NOTION_API_KEY")),
    bool(os.getenv("NOTION_DATABASE_ID")),
)

from fastapi import BackgroundTasks, Body, FastAPI, HTTPException, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

from app.application_package import generate_application_package_for_job
from app.apply_action import materialize_job_read
from app.enums import ApplicationStatus, ResumeVariantId, RoleFamily
from app.notion_service import sync_application_package_to_notion
from app.notion_service import (
    log_notion_environment_at_startup,
    preview_notion_payload_for_job,
    sync_scored_job_to_notion,
    update_notion_job_status,
)
from app.outreach import (
    OUTREACH_MIN_FIT_SCORE,
    HiringRelationshipContext,
    build_hiring_team_outreach_message,
    generate_outreach_for_job,
    hiring_relationship_from_pydantic,
    hiring_team_automation_eligible,
    linkedin_url_for_hiring_contact,
    outreach_draft_plain_text,
)
from app.schemas import (
    ApplicationPackageResponse,
    ExtensionPopupStatusUpdate,
    FullIntakeResponse,
    GenerateOutreachRequest,
    GenerateOutreachResponse,
    HiringOutreachContextRequest,
    HiringOutreachSuggestionResponse,
    JobCreate,
    SalaryGuidanceResponse,
    JobRead,
    JobStatusUpdate,
    JobUpdate,
    ScoreJobRequest,
    ScoreJobResponse,
)
from app.status_workflow import validate_status_transition
from app.salary_guidance import build_salary_guidance, compute_salary_debug
from app.scoring import get_scoring_thresholds, load_scoring_config, score_job
from app.resume_loader import get_resumes, get_resume_display_name

logger = logging.getLogger("job_copilot")


class LogScoreAndCreateBodyMiddleware(BaseHTTPMiddleware):
    """Log raw JSON for POST /score-and-create-job before Pydantic parsing."""

    async def dispatch(self, request: Request, call_next):
        if request.method == "POST" and request.url.path.rstrip("/").endswith(
            "score-and-create-job"
        ):
            body = await request.body()
            try:
                preview = body.decode("utf-8", errors="replace")
            except Exception:
                preview = repr(body)
            logger.info(
                "[score-and-create-job] raw body len=%s: %s",
                len(body),
                preview[:20000],
            )

            async def receive():
                return {"type": "http.request", "body": body, "more_body": False}

            request = Request(request.scope, receive)
        return await call_next(request)


def _hiring_relationship_from_extension_payload(
    payload: HiringOutreachContextRequest,
) -> HiringRelationshipContext:
    if payload.relationship_context is not None:
        return hiring_relationship_from_pydantic(payload.relationship_context)
    return HiringRelationshipContext(
        shared_company_names=tuple(payload.shared_company_names[:5]),
        contact_seniority=payload.contact_seniority,
        contact_type=payload.contact_type,
    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    load_scoring_config()
    log_notion_environment_at_startup()
    # Load resume variants from resumes/ folder (warn if missing, don't crash)
    resumes = get_resumes()
    if resumes:
        print(f"[RESUMES] {len(resumes)} variant(s) loaded: {list(resumes.keys())}")
    else:
        print("[RESUMES] ⚠️  No resume PDFs loaded — add PDFs to the resumes/ folder.")
    yield


app = FastAPI(title="Job Copilot API", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(LogScoreAndCreateBodyMiddleware)


@app.get("/", include_in_schema=False)
def health_check():
    return {"status": "ok"}


@app.exception_handler(RequestValidationError)
async def request_validation_exception_handler(
    request: Request, exc: RequestValidationError
):
    logger.warning(
        "[422] validation failed path=%s errors=%s",
        request.url.path,
        exc.errors(),
    )
    return JSONResponse(status_code=422, content={"detail": exc.errors()})


# Lean in-memory store for MVP scaffolding.
jobs_store: Dict[int, JobRead] = {}
next_job_id = 1


def _normalize_for_dedup(text: str) -> str:
    """
    Normalize title/company for duplicate checks: lowercase, trim, strip punctuation,
    collapse runs of spaces to one. No fuzzy matching.
    """
    t = text.strip().lower()
    t = re.sub(r"[^\w\s]", "", t, flags=re.UNICODE)
    t = re.sub(r"\s+", " ", t).strip()
    return t


def _job_identity_key(title: str, company: str) -> tuple[str, str]:
    return (_normalize_for_dedup(title), _normalize_for_dedup(company))


def _find_job_by_title_company(title: str, company: str) -> Optional[JobRead]:
    key = _job_identity_key(title, company)
    for job in jobs_store.values():
        if _job_identity_key(job.title, job.company) == key:
            return job
    return None


def _find_job_by_linkedin_job_id(lid: str) -> Optional[JobRead]:
    lid = (lid or "").strip()
    if not lid:
        return None
    for job in jobs_store.values():
        if (job.linkedin_job_id or "").strip() == lid:
            return job
    return None


def _effective_title_company(payload: ScoreJobRequest) -> tuple[str, str]:
    t = (payload.extracted_title or payload.title or "").strip()
    c = (payload.extracted_company or payload.company or "").strip()
    return t, c


def _effective_source_url(payload: ScoreJobRequest) -> Optional[str]:
    u = (payload.normalized_job_url or payload.source_url or "").strip()
    return u or None


def _safe_sync_scored_job_to_notion(job: JobRead) -> tuple[JobRead, bool, Optional[str]]:
    """
    Upsert scored job to Notion. Fail-open: never raises; returns (job, ok, error_message).
    """
    try:
        result = sync_scored_job_to_notion(job)
    except Exception as e:
        logging.getLogger(__name__).exception(
            "sync_scored_job_to_notion failed for job_id=%s",
            job.id,
        )
        return job, False, (str(e) or "notion_sync_failed")[:500]

    if result.get("notion_page_id"):
        updated = job.model_copy(update={"notion_page_id": result["notion_page_id"]})
        jobs_store[job.id] = updated
        return updated, True, None

    err = result.get("error")
    if err is not None:
        return job, False, str(err)[:500]

    return job, False, "notion_sync_failed"


def _transition_job_status(job_id: int, new_status: ApplicationStatus) -> JobRead:
    """Validate workflow, persist status, sync Status to Notion. Raises HTTPException on error."""
    existing = jobs_store.get(job_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="Job not found")
    ok, err = validate_status_transition(existing.status, new_status)
    if not ok:
        raise HTTPException(status_code=400, detail=err)
    updated = existing.model_copy(
        update={
            "status": new_status,
            "updated_at": datetime.now(timezone.utc),
        }
    )
    jobs_store[job_id] = updated
    nr = update_notion_job_status(materialize_job_read(updated))
    if nr.get("resolved_notion_page_id"):
        updated = updated.model_copy(
            update={"notion_page_id": nr["resolved_notion_page_id"]}
        )
        jobs_store[job_id] = updated
    return materialize_job_read(updated)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/enums/status", response_model=List[ApplicationStatus])
def list_statuses() -> List[ApplicationStatus]:
    return list(ApplicationStatus)


@app.get("/enums/resume-variants", response_model=List[ResumeVariantId])
def list_resume_variants() -> List[ResumeVariantId]:
    return list(ResumeVariantId)


@app.get("/enums/role-families", response_model=List[RoleFamily])
def list_role_families() -> List[RoleFamily]:
    return list(RoleFamily)


@app.post("/jobs", response_model=JobRead)
def create_job(payload: JobCreate, response: Response) -> JobRead:
    global next_job_id

    existing = _find_job_by_title_company(payload.title, payload.company)
    if existing is not None:
        response.status_code = 200
        return materialize_job_read(existing)

    now = datetime.now(timezone.utc)
    job = JobRead(
        id=next_job_id,
        company=payload.company,
        title=payload.title,
        location=payload.location,
        role_family=payload.role_family,
        source_url=payload.source_url,
        job_description=payload.job_description,
        notion_page_id=payload.notion_page_id,
        fit_score=payload.fit_score,
        recommended_resume_variant=payload.recommended_resume_variant,
        status=payload.status,
        has_open_ended_questions=payload.has_open_ended_questions,
        decision=None,
        created_at=now,
        updated_at=now,
    )
    jobs_store[next_job_id] = job
    next_job_id += 1
    response.status_code = 201
    return materialize_job_read(job)


@app.post("/jobs/full-intake", response_model=FullIntakeResponse)
def full_intake(payload: ScoreJobRequest, background_tasks: BackgroundTasks) -> FullIntakeResponse:
    inner = Response()
    created = score_and_create_job(payload, inner)
    if isinstance(created, JSONResponse):
        body = json.loads(created.body.decode())
        raise HTTPException(
            status_code=500,
            detail=body.get("error", "Job creation failed"),
        )
    job = created
    jid = job.id
    outreach: Optional[GenerateOutreachResponse] = None
    outreach_error: Optional[str] = None
    package: Optional[ApplicationPackageResponse] = None
    application_package_error: Optional[str] = None

    try:
        outreach = generate_outreach(jid)
    except HTTPException as e:
        outreach_error = e.detail if isinstance(e.detail, str) else str(e.detail)
    except Exception as e:
        outreach_error = str(e)

    try:
        package = generate_application_package(jid, background_tasks)
    except HTTPException as e:
        application_package_error = (
            e.detail if isinstance(e.detail, str) else str(e.detail)
        )
    except Exception as e:
        application_package_error = str(e)

    final_job = materialize_job_read(jobs_store[jid])
    return FullIntakeResponse(
        job=final_job,
        outreach=outreach,
        application_package=package,
        outreach_error=outreach_error,
        application_package_error=application_package_error,
    )


@app.get("/jobs", response_model=List[JobRead])
def list_jobs() -> List[JobRead]:
    return [materialize_job_read(j) for j in jobs_store.values()]


@app.get("/jobs/{job_id}", response_model=JobRead)
def get_job(job_id: int) -> JobRead:
    job = jobs_store.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return materialize_job_read(job)


@app.get("/jobs/{job_id}/salary-guidance", response_model=SalaryGuidanceResponse)
def salary_guidance(
    job_id: int,
    run_id: Optional[str] = None,
) -> SalaryGuidanceResponse:
    """Suggested annual base range: from JD when present, else market heuristics."""
    job = jobs_store.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return build_salary_guidance(materialize_job_read(job))


_APPLIED_UI_STATUSES: frozenset[ApplicationStatus] = frozenset(
    {
        ApplicationStatus.APPLIED,
        ApplicationStatus.APPLIED_PENDING_CONFIRMATION,
        ApplicationStatus.APPLIED_CONFIRMED,
    }
)

_REVIEWING_UI_STATUSES: frozenset[ApplicationStatus] = frozenset(
    {
        ApplicationStatus.READY_TO_APPLY,
        ApplicationStatus.SHORTLISTED,
        ApplicationStatus.NEEDS_REVIEW,
        ApplicationStatus.OUTREACH_DRAFTED,
        ApplicationStatus.OUTREACH_SENT,
    }
)

_SKIPPED_UI_STATUSES: frozenset[ApplicationStatus] = frozenset(
    {
        ApplicationStatus.SKIPPED,
        ApplicationStatus.REJECTED,
    }
)


@app.get("/jobs/{job_id}/status")
def get_job_extension_status(job_id: int) -> dict:
    """Lightweight status for extension UI persistence (Applied / Reviewing / Skipped / none)."""
    job = jobs_store.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    fit = job.fit_score if job.fit_score is not None else 0
    applied = job.status in _APPLIED_UI_STATUSES
    priority_hiring_outreach = (
        applied
        and not job.hiring_outreach_sent
        and job.hiring_team_visible
        and fit >= 75
    )
    out: dict = {
        "hiring_outreach_sent": job.hiring_outreach_sent,
        "priority_hiring_outreach": priority_hiring_outreach,
        "fit_score": fit,
    }
    if applied:
        out["status"] = "Applied"
    elif job.status in _REVIEWING_UI_STATUSES:
        out["status"] = "Reviewing"
    elif job.status in _SKIPPED_UI_STATUSES:
        out["status"] = "Skipped"
    else:
        out["status"] = None
    return out


def _bg_sync_package_to_notion(job_id: int, package: ApplicationPackageResponse) -> None:
    """Background task: ensure Notion row exists, then push the application package details.

    Reads the latest job from jobs_store so we pick up any notion_page_id written
    by a concurrent /score-and-create-job call.
    """
    try:
        job = jobs_store.get(job_id)
        if job is None:
            return
        # Only create the row if /score-and-create-job didn't already.
        if not job.notion_page_id:
            notion_result = sync_scored_job_to_notion(job)
            if notion_result and notion_result.get("notion_page_id"):
                job = job.model_copy(
                    update={"notion_page_id": notion_result["notion_page_id"]}
                )
                jobs_store[job_id] = job
        sync_application_package_to_notion(job, package)
    except Exception:
        logging.getLogger(__name__).exception(
            "[BG] sync_application_package_to_notion failed for job_id=%s", job_id
        )


@app.post(
    "/jobs/{job_id}/generate-application-package",
    response_model=ApplicationPackageResponse,
)
def generate_application_package(
    job_id: int,
    background_tasks: BackgroundTasks,
    run_id: Optional[str] = None,
) -> ApplicationPackageResponse:
    # Deterministic application package: fit summary, experience mapping, resume, strategy, talking points.
    job = jobs_store.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")

    package = generate_application_package_for_job(job)

    # Defer Notion writes — they're 1-3s of latency the user doesn't need to wait on.
    # /score-and-create-job already created the base row; this background task
    # handles the package detail update (and creates the row if it's somehow missing).
    background_tasks.add_task(_bg_sync_package_to_notion, job_id, package)

    return package


@app.post("/jobs/{job_id}/generate-outreach", response_model=GenerateOutreachResponse)
def generate_outreach(
    job_id: int,
    payload: Optional[GenerateOutreachRequest] = Body(None),
) -> GenerateOutreachResponse:
    """Return review-only outreach drafts. Nothing is sent automatically."""
    p = payload or GenerateOutreachRequest()

    job = jobs_store.get(job_id)

    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")

    job = materialize_job_read(job)

    apply_t, review_t = get_scoring_thresholds()
    if job.fit_score is None or job.fit_score < OUTREACH_MIN_FIT_SCORE:
        detail_msg = (
            f"Outreach drafts require fit_score >= {OUTREACH_MIN_FIT_SCORE}. "
            f"Current fit_score: {job.fit_score!r}."
        )
        raise HTTPException(status_code=400, detail=detail_msg)

    ok, err = validate_status_transition(job.status, ApplicationStatus.OUTREACH_DRAFTED)
    if not ok:
        raise HTTPException(status_code=400, detail=err)

    rc = p.relationship_context
    rel = hiring_relationship_from_pydantic(rc)

    try:
        resp = generate_outreach_for_job(
            job, apply_t, review_t,
            relationship=rel,
            user_relationship_flag=p.user_relationship_flag,
            user_profile=p.user_profile,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        raise

    now = datetime.now(timezone.utc)
    updated = job.model_copy(
        update={
            "status": ApplicationStatus.OUTREACH_DRAFTED,
            "updated_at": now,
        }
    )
    jobs_store[job_id] = updated
    update_notion_job_status(materialize_job_read(updated))
    return resp


@app.post("/jobs/{job_id}/mark-outreach-sent", response_model=JobRead)
def mark_outreach_sent(job_id: int) -> JobRead:
    """Set status to Outreach Sent after outreach has been sent."""
    return _transition_job_status(job_id, ApplicationStatus.OUTREACH_SENT)


@app.post(
    "/jobs/{job_id}/hiring-outreach-suggest",
    response_model=HiringOutreachSuggestionResponse,
)
def hiring_outreach_suggest(
    job_id: int, payload: HiringOutreachContextRequest
) -> HiringOutreachSuggestionResponse:
    """Store hiring-team scrape from the extension and return a personalized message + LinkedIn URL."""
    job = jobs_store.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    now = datetime.now(timezone.utc)
    updated = job.model_copy(
        update={
            "hiring_team_visible": payload.hiring_team_visible,
            "hiring_manager_name": payload.hiring_manager_name,
            "hiring_manager_role": payload.hiring_manager_role,
            "hiring_manager_profile_url": payload.hiring_manager_profile_url,
            "updated_at": now,
        }
    )
    jobs_store[job_id] = updated
    job = updated
    if not hiring_team_automation_eligible(job, payload.hiring_team_visible):
        return HiringOutreachSuggestionResponse(
            eligible=False,
            hiring_outreach_sent=job.hiring_outreach_sent,
            reason="Requires fit score ≥ 75 and hiring team visible on the job page.",
        )
    rel = _hiring_relationship_from_extension_payload(payload)
    msg, outreach_mode = build_hiring_team_outreach_message(job, relationship=rel)
    url = linkedin_url_for_hiring_contact(
        job.hiring_manager_name,
        job.company,
        job.hiring_manager_profile_url,
    )
    return HiringOutreachSuggestionResponse(
        eligible=True,
        hiring_outreach_sent=job.hiring_outreach_sent,
        message=msg,
        linkedin_url=url,
        hiring_manager_name=job.hiring_manager_name,
        hiring_manager_role=job.hiring_manager_role,
        outreach_mode=outreach_mode,
    )


@app.post("/jobs/{job_id}/mark-hiring-outreach-sent", response_model=JobRead)
def mark_hiring_outreach_sent(job_id: int) -> JobRead:
    """Mark hiring-team LinkedIn outreach as sent (separate from recruiter draft status)."""
    job = jobs_store.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    now = datetime.now(timezone.utc)
    updated = job.model_copy(
        update={"hiring_outreach_sent": True, "updated_at": now}
    )
    jobs_store[job_id] = updated
    return materialize_job_read(updated)


@app.post("/jobs/{job_id}/mark-applied", response_model=JobRead)
def mark_applied(job_id: int) -> JobRead:
    """Set status to Applied after submitting an application."""
    return _transition_job_status(job_id, ApplicationStatus.APPLIED)


@app.get("/jobs/{job_id}/outreach-preview")
def outreach_preview(
    job_id: int,
    draft_type: Literal["hiring_manager", "recruiter", "warm_connection"] = Query(
        ...,
        alias="type",
        description="Which draft to return as plain text.",
    ),
) -> Response:
    """Return a single outreach draft as raw text for easy copy into email or Docs."""
    job = jobs_store.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")

    job = materialize_job_read(job)

    if job.fit_score is None or job.fit_score < OUTREACH_MIN_FIT_SCORE:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Outreach drafts require fit_score >= {OUTREACH_MIN_FIT_SCORE}. "
                f"Current fit_score: {job.fit_score!r}."
            ),
        )

    text = outreach_draft_plain_text(job, draft_type)
    return Response(content=text, media_type="text/plain; charset=utf-8")


@app.patch("/jobs/{job_id}/status", response_model=JobRead)
def patch_job_status(job_id: int, payload: JobStatusUpdate) -> JobRead:
    return _transition_job_status(job_id, payload.status)


_EXT_UI_TO_STATUS: dict[str, ApplicationStatus] = {
    "New": ApplicationStatus.NEW,
    "Reviewing": ApplicationStatus.NEEDS_REVIEW,
    "Applied": ApplicationStatus.APPLIED,
    "Skipped": ApplicationStatus.SKIPPED,
}


@app.post("/jobs/{job_id}/update-status")
def extension_update_status(
    job_id: int, payload: ExtensionPopupStatusUpdate
) -> dict:
    """Chrome extension: set job status from simple UI labels (direct assign)."""
    existing = jobs_store.get(job_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="Job not found")
    new_status = _EXT_UI_TO_STATUS[payload.status]
    updated = existing.model_copy(
        update={"status": new_status, "updated_at": datetime.now(timezone.utc)}
    )
    jobs_store[job_id] = updated
    nr = update_notion_job_status(materialize_job_read(updated))
    if nr.get("resolved_notion_page_id"):
        updated = updated.model_copy(
            update={"notion_page_id": nr["resolved_notion_page_id"]}
        )
        jobs_store[job_id] = updated
    return {"success": True, "job_id": job_id, "status": payload.status}


@app.get("/jobs/{job_id}/notion-preview")
def notion_preview(job_id: int) -> dict:
    """Return the Notion `create page` JSON body that would be used for this job (no API call)."""
    job = jobs_store.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Job not found")
    return preview_notion_payload_for_job(job)


@app.patch("/jobs/{job_id}", response_model=JobRead)
def update_job(job_id: int, payload: JobUpdate) -> JobRead:
    existing = jobs_store.get(job_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="Job not found")

    updates = payload.model_dump(exclude_unset=True)
    updated_job = existing.model_copy(
        update={**updates, "updated_at": datetime.now(timezone.utc)}
    )
    jobs_store[job_id] = updated_job
    return materialize_job_read(updated_job)


@app.post("/score-job", response_model=ScoreJobResponse)
def score_job_endpoint(payload: ScoreJobRequest) -> ScoreJobResponse:
    return ScoreJobResponse(
        **score_job(
            title=payload.title,
            company=payload.company,
            job_description=payload.job_description,
            location=payload.location,
            user_profile=payload.user_profile,
        )
    )


@app.post("/score-and-create-job")
def score_and_create_job(payload: ScoreJobRequest, response: Response):
    """Create or return existing job; logs full flow. Errors return ``{success, error}`` JSON."""
    global next_job_id

    try:
        title_eff, company_eff = _effective_title_company(payload)
        src_eff = _effective_source_url(payload)
        lid = (payload.linkedin_job_id or "").strip()

        # Diagnostic: print what we actually received, so we can confirm whether
        # the extension's chip-rescue text reached the backend untouched.
        jd_full = payload.job_description or ""
        print(
            f"[BACKEND DIAG] /score-and-create-job title={title_eff!r} "
            f"company={company_eff!r} jd_len={len(jd_full)}"
        )
        print(f"[BACKEND DIAG] jd_tail (last 600 chars): {jd_full[-600:]!r}")

        if lid:
            by_lid = _find_job_by_linkedin_job_id(lid)
            if by_lid is not None:
                scored_raw = score_job(
                    title=title_eff,
                    company=company_eff,
                    job_description=payload.job_description,
                    location=payload.location,
                    user_profile=payload.user_profile,
                )
                now = datetime.now(timezone.utc)
                refreshed = by_lid.model_copy(
                    update={
                        "title": title_eff,
                        "company": company_eff,
                        "job_description": payload.job_description,
                        "location": (payload.location or "").strip() or None,
                        "source_url": src_eff,
                        "linkedin_job_id": lid,
                        "fit_score": scored_raw["fit_score"],
                        "role_family": scored_raw["role_family"],
                        "recommended_resume_variant": scored_raw["recommended_resume_variant"],
                        "resume_recommendation_display": scored_raw.get("resume_recommendation_display", ""),
                        "has_open_ended_questions": scored_raw["has_open_ended_questions"],
                        "decision": scored_raw["decision"],
                        "recommended_action": scored_raw["recommended_action"],
                        "action_rationale": scored_raw["action_rationale"],
                        "scoring_rationale": scored_raw["rationale"],
                        "salary_debug": scored_raw["salary_debug"],
                        "domain_mismatch": scored_raw.get("domain_mismatch", False),
                        "domain_mismatch_reason": scored_raw.get("domain_mismatch_reason"),
                        "updated_at": now,
                    }
                )
                jobs_store[refreshed.id] = refreshed
                refreshed, n_ok, n_err = _safe_sync_scored_job_to_notion(refreshed)
                response.status_code = 200
                out = materialize_job_read(refreshed)
                return out.model_copy(
                    update={"notion_sync_ok": n_ok, "notion_sync_error": n_err}
                )

        existing = _find_job_by_title_company(title_eff, company_eff)
        if existing is not None:
            response.status_code = 200
            merged: dict = {}
            if src_eff:
                merged["source_url"] = src_eff
            if lid:
                merged["linkedin_job_id"] = lid
            sd_dup = compute_salary_debug(
                title_eff,
                payload.job_description,
                existing.role_family,
                existing.location,
            )
            merged["salary_debug"] = sd_dup
            if merged:
                merged["updated_at"] = datetime.now(timezone.utc)
                existing = existing.model_copy(update=merged)
                jobs_store[existing.id] = existing
            existing, n_ok, n_err = _safe_sync_scored_job_to_notion(existing)
            out = materialize_job_read(existing)
            return out.model_copy(
                update={"notion_sync_ok": n_ok, "notion_sync_error": n_err}
            )

        scored = ScoreJobResponse(
            **score_job(
                title=title_eff,
                company=company_eff,
                job_description=payload.job_description,
                location=payload.location,
                user_profile=payload.user_profile,
            )
        )

        apply_t, _ = get_scoring_thresholds()
        initial_status = (
            ApplicationStatus.READY_TO_APPLY
            if scored.fit_score >= apply_t
            else ApplicationStatus.NEW
        )
        now = datetime.now(timezone.utc)

        job = JobRead(
            id=next_job_id,
            company=company_eff,
            title=title_eff,
            location=(payload.location or "").strip() or None,
            role_family=scored.role_family,
            source_url=src_eff,
            linkedin_job_id=(lid or None),
            job_description=payload.job_description,
            fit_score=scored.fit_score,
            recommended_resume_variant=scored.recommended_resume_variant,
            resume_recommendation_display=scored.resume_recommendation_display,
            status=initial_status,
            has_open_ended_questions=scored.has_open_ended_questions,
            decision=scored.decision,
            recommended_action=scored.recommended_action,
            action_rationale=scored.action_rationale,
            scoring_rationale=scored.rationale,
            salary_debug=scored.salary_debug,
            domain_mismatch=scored.domain_mismatch,
            domain_mismatch_reason=scored.domain_mismatch_reason,
            created_at=now,
            updated_at=now,
        )

        jid = next_job_id
        jobs_store[jid] = job
        next_job_id += 1

        job, n_ok, n_err = _safe_sync_scored_job_to_notion(job)

        response.status_code = 201
        out = materialize_job_read(job)
        return out.model_copy(
            update={"notion_sync_ok": n_ok, "notion_sync_error": n_err}
        )

    except Exception as e:
        print("❌ [JOB CREATE ERROR]", str(e))
        traceback.print_exc()
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(e)},
        )