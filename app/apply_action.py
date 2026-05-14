"""Deterministic recommended next action from fit score and application status."""

from __future__ import annotations

from app.enums import ApplicationStatus, RecommendedAction
from app.schemas import JobRead

# Treat these as "already applied" for the Apply Now rule.
_ALREADY_APPLIED_STATUSES: frozenset[ApplicationStatus] = frozenset(
    {
        ApplicationStatus.APPLIED,
        ApplicationStatus.APPLIED_PENDING_CONFIRMATION,
        ApplicationStatus.APPLIED_CONFIRMED,
    }
)


def compute_recommended_action(
    fit_score: int, status: ApplicationStatus | None
) -> tuple[RecommendedAction, str]:
    """
    Rules (aligned with recalibrated scoring bands):
    - Already in an applied state → Skip (with explanation).
    - fit_score >= 80 → Apply Now (if not already applied).
    - 70–79 → Outreach First (good fit—apply with tailored positioning or a warm intro).
    - 55–69 → Review Manually (partial / possible fit).
    - < 55 → Skip.
    """
    if status is not None and status in _ALREADY_APPLIED_STATUSES:
        return (
            RecommendedAction.SKIP,
            "Application already submitted or in progress; no new apply action needed.",
        )
    if fit_score >= 80:
        return (
            RecommendedAction.APPLY_NOW,
            "Fit score 80 or above; strong match—submit unless something material changed.",
        )
    if 70 <= fit_score <= 79:
        return (
            RecommendedAction.OUTREACH_FIRST,
            "Fit score in the 70–79 range; good fit—apply with tailored positioning or a short warm intro.",
        )
    if 55 <= fit_score <= 69:
        return (
            RecommendedAction.REVIEW_MANUALLY,
            "Fit score in the 55–69 range; partial fit—read closely before committing time.",
        )
    return (
        RecommendedAction.SKIP,
        "Fit score below 55; weak fit unless you have a strong non-obvious angle.",
    )


def materialize_job_read(job: JobRead) -> JobRead:
    """Attach ``recommended_action`` and ``action_rationale`` from current fit score and status."""
    if job.fit_score is None:
        return job
    action, rationale = compute_recommended_action(job.fit_score, job.status)
    return job.model_copy(
        update={
            "recommended_action": action,
            "action_rationale": rationale,
        }
    )
