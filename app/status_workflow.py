"""Allowed job status transitions (ApplicationStatus workflow)."""

from __future__ import annotations

from app.enums import ApplicationStatus

_TERMINAL: frozenset[ApplicationStatus] = frozenset(
    {ApplicationStatus.REJECTED, ApplicationStatus.SKIPPED, ApplicationStatus.WITHDRAWN}
)

# Primary pipeline (explicit forward edges only).
_FORWARD: frozenset[tuple[ApplicationStatus, ApplicationStatus]] = frozenset(
    {
        (ApplicationStatus.SCORED, ApplicationStatus.READY_TO_APPLY),
        (ApplicationStatus.READY_TO_APPLY, ApplicationStatus.APPLIED_PENDING_CONFIRMATION),
        (
            ApplicationStatus.APPLIED_PENDING_CONFIRMATION,
            ApplicationStatus.APPLIED_CONFIRMED,
        ),
        (ApplicationStatus.APPLIED_CONFIRMED, ApplicationStatus.RECRUITER_CONTACT),
        (ApplicationStatus.RECRUITER_CONTACT, ApplicationStatus.INTERVIEWING),
        (ApplicationStatus.INTERVIEWING, ApplicationStatus.FINAL_ROUND),
        (ApplicationStatus.FINAL_ROUND, ApplicationStatus.OFFER),
        # Drafting outreach (POST /jobs/{id}/generate-outreach) moves into Outreach Drafted.
        (ApplicationStatus.NEW, ApplicationStatus.OUTREACH_DRAFTED),
        (ApplicationStatus.SCORED, ApplicationStatus.OUTREACH_DRAFTED),
        (ApplicationStatus.SHORTLISTED, ApplicationStatus.OUTREACH_DRAFTED),
        (ApplicationStatus.READY_TO_APPLY, ApplicationStatus.OUTREACH_DRAFTED),
        (ApplicationStatus.NEEDS_REVIEW, ApplicationStatus.OUTREACH_DRAFTED),
        (ApplicationStatus.OUTREACH_SENT, ApplicationStatus.OUTREACH_DRAFTED),
        # Outreach sent / applied (dedicated POST endpoints).
        (ApplicationStatus.OUTREACH_DRAFTED, ApplicationStatus.OUTREACH_SENT),
        (ApplicationStatus.OUTREACH_SENT, ApplicationStatus.APPLIED),
        (ApplicationStatus.APPLIED, ApplicationStatus.RECRUITER_CONTACT),
    }
)


def _is_terminal(status: ApplicationStatus) -> bool:
    return status in _TERMINAL


def validate_status_transition(
    current: ApplicationStatus, target: ApplicationStatus
) -> tuple[bool, str]:
    """
    Return (ok, error_message). error_message is empty when ok is True.
    """
    if current == target:
        return True, ""

    if _is_terminal(current):
        return (
            False,
            f"Cannot change status from terminal state {current.value!r}.",
        )

    if target in (
        ApplicationStatus.REJECTED,
        ApplicationStatus.SKIPPED,
        ApplicationStatus.WITHDRAWN,
    ):
        return True, ""

    if (current, target) in _FORWARD:
        return True, ""

    allowed = sorted(
        {t for (f, t) in _FORWARD if f == current},
        key=lambda s: s.value,
    )
    if allowed:
        allowed_str = ", ".join(s.value for s in allowed)
        return (
            False,
            f"Invalid transition from {current.value!r} to {target.value!r}. "
            f"Allowed next states: {allowed_str}; or Rejected / Skipped / Withdrawn.",
        )
    return (
        False,
        f"Invalid transition from {current.value!r} to {target.value!r}. "
        "Use the workflow chain starting at Scored → Ready to Apply, or move to Rejected / Skipped / Withdrawn.",
    )
