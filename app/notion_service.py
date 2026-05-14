"""
Lightweight Notion sync helpers for scored jobs.

Property names in :func:`job_to_notion_page_payload` must match your Notion database schema.

Expected environment variables (single source of truth — use these exact names):
  - :data:`NOTION_ENV_API_KEY`
  - :data:`NOTION_ENV_DATABASE_ID`
"""

from __future__ import annotations

import json
import logging
import os
import traceback
from typing import Any

import requests

from app.apply_action import materialize_job_read
from app.schemas import ApplicationPackageResponse, JobRead

logger = logging.getLogger(__name__)

# Canonical Notion integration env var names (documented + used for os.getenv keys).
NOTION_ENV_API_KEY = "NOTION_API_KEY"
NOTION_ENV_DATABASE_ID = "NOTION_DATABASE_ID"
NOTION_API_VERSION = "2022-06-28"


def _notion_api_key_from_env() -> str:
    return os.getenv(NOTION_ENV_API_KEY, "").strip()


def _notion_database_id_from_env() -> str:
    """
    Database ID exactly as in NOTION_DATABASE_ID (only leading/trailing whitespace stripped).
    No UUID reformatting — Notion accepts both dashed and undashed forms per their API.
    """
    return os.getenv(NOTION_ENV_DATABASE_ID, "").strip()


def _log_notion_request_database_id(database_id: str, context: str) -> None:
    """Exact string used in URL or JSON body for Notion database operations."""
    print("[NOTION REQUEST] database_id being used:", database_id, f"({context})")


def notion_missing_env_vars() -> list[str]:
    """Names of required env vars that are unset or blank."""
    missing: list[str] = []
    if not _notion_api_key_from_env():
        missing.append(NOTION_ENV_API_KEY)
    if not _notion_database_id_from_env():
        missing.append(NOTION_ENV_DATABASE_ID)
    return missing


def log_notion_environment_at_startup() -> None:
    """
    Log whether Notion credentials are present (boolean only — never log secrets).
    Call once from the FastAPI lifespan.
    """
    has_key = bool(_notion_api_key_from_env())
    has_db = bool(_notion_database_id_from_env())
    print("[NOTION CONFIG] NOTION_API_KEY present:", has_key)
    print("[NOTION CONFIG] NOTION_DATABASE_ID present:", has_db)
    if not has_key or not has_db:
        print("NOTION CONFIG MISSING")
        for name in notion_missing_env_vars():
            print("[NOTION CONFIG] missing env:", name)

RESUME_VARIANT_SELECT_NAME: dict[str, str] = {
    "master_2026": "Master 2026",
    "revops_q": "RevOps Q",
    "strategic_ops_a": "Strategic Ops A",
    "cx_c": "CX C",
    "cx_ops_l": "CX Ops L",
    "startup_builder_sb": "Startup Builder SB",
}


def notion_credentials_configured() -> bool:
    return bool(
        _notion_api_key_from_env() and _notion_database_id_from_env()
    )


def _notion_headers() -> dict[str, str]:
    """Build headers on each call so the API key from the environment is always current."""
    key = _notion_api_key_from_env()
    return {
        "Authorization": f"Bearer {key}",
        "Notion-Version": NOTION_API_VERSION,
        "Content-Type": "application/json",
    }


def _parse_notion_response_json(resp: requests.Response) -> dict[str, Any] | None:
    """Parse JSON body or return None; logs raw text on failure."""
    try:
        data = resp.json()
    except ValueError:
        print("NOTION RESPONSE: <invalid JSON>", (resp.text or "")[:4000])
        return None
    if isinstance(data, dict):
        return data
    print("NOTION RESPONSE:", data)
    return None


def _rich_text(content: str | None) -> dict[str, Any]:
    text = (content or "").strip() or "—"
    return {
        "rich_text": [
            {
                "type": "text",
                "text": {"content": text[:2000], "link": None},
            }
        ]
    }


def _rich_text_long(content: str | None) -> dict[str, Any]:
    """Rich text with multiple segments when content exceeds Notion's 2000-char segment limit."""
    text = (content or "").strip() or "—"
    segments: list[dict[str, Any]] = []
    for i in range(0, len(text), 2000):
        segments.append(
            {
                "type": "text",
                "text": {"content": text[i : i + 2000], "link": None},
            }
        )
        if len(segments) >= 20:
            break
    return {"rich_text": segments}


def _title(content: str) -> dict[str, Any]:
    return {
        "title": [
            {
                "type": "text",
                "text": {"content": content[:2000], "link": None},
            }
        ]
    }


def _number(value: int | None) -> dict[str, Any]:
    return {"number": value}


def _select(name: str | None) -> dict[str, Any]:
    if not name:
        return {"select": None}
    return {"select": {"name": name[:100]}}


def _url(value: str | None) -> dict[str, Any]:
    url = (value or "").strip()
    return {"url": url or None}


def _date_iso(dt) -> dict[str, Any]:
    return {"date": {"start": dt.isoformat()}}


def _notion_upsert_row_properties(job: JobRead) -> dict[str, Any]:
    """PATCH payload: status, fit score, resume variant, updated, Job URL, Linkedin Job ID."""
    job = materialize_job_read(job)
    resume_id = job.recommended_resume_variant.value if job.recommended_resume_variant else ""
    resume_select = RESUME_VARIANT_SELECT_NAME.get(resume_id, "")
    props: dict[str, Any] = {
        "Status": _select(job.status.value),
        "Fit score": _number(job.fit_score),
        "Resume variant": _select(resume_select),
        "Updated": _date_iso(job.updated_at),
        "Job URL": _url(job.source_url),
    }
    li = (job.linkedin_job_id or "").strip()
    if li:
        props["Linkedin Job ID"] = _rich_text(li)
    return props


def _query_notion_pages_by_linkedin_job_id_exact(ljid: str) -> list[dict[str, Any]]:
    """
    Search Notion for rows where **Linkedin Job ID** (rich_text) equals ``ljid`` exactly.
    """
    db_id = _notion_database_id_from_env()
    if not db_id or not notion_credentials_configured():
        return []

    print("[NOTION MATCH] querying property: Linkedin Job ID")
    _log_notion_request_database_id(db_id, "POST /v1/databases/{id}/query (Linkedin Job ID)")
    query_url = f"https://api.notion.com/v1/databases/{db_id}/query"
    body: dict[str, Any] = {
        "filter": {"property": "Linkedin Job ID", "rich_text": {"equals": ljid}},
        "page_size": 100,
    }
    resp = requests.post(
        query_url,
        headers=_notion_headers(),
        json=body,
        timeout=20,
    )

    if resp.status_code != 200:
        raise RuntimeError(
            f"Notion database query (Linkedin Job ID) failed: {resp.status_code} {resp.text}"
        )

    data = resp.json()
    results = data.get("results") if isinstance(data, dict) else None
    if not results:
        return []
    return [r for r in results if isinstance(r, dict)]


def _query_notion_pages_by_source_url_exact(url_val: str) -> list[dict[str, Any]]:
    """
    Search the Notion database for rows where **Job URL** equals ``url_val`` exactly.
    Does not use Job Copilot ID (avoids broad OR matches). Raises on transport/query failure.
    """
    db_id = _notion_database_id_from_env()
    if not db_id or not notion_credentials_configured():
        print(
            "[NOTION UPSERT] _query_notion_pages_by_source_url_exact: skipping DB query "
            f"(db_id set={bool(db_id)} credentials={notion_credentials_configured()}) -> 0 results"
        )
        return []

    _log_notion_request_database_id(db_id, "POST /v1/databases/{id}/query (Job URL)")
    query_url = f"https://api.notion.com/v1/databases/{db_id}/query"
    body: dict[str, Any] = {
        "filter": {"property": "Job URL", "url": {"equals": url_val}},
        "page_size": 100,
    }
    resp = requests.post(
        query_url,
        headers=_notion_headers(),
        json=body,
        timeout=20,
    )

    if resp.status_code != 200:
        raise RuntimeError(
            f"Notion database query failed: {resp.status_code} {resp.text}"
        )

    data = resp.json()
    results = data.get("results") if isinstance(data, dict) else None
    if not results:
        return []
    return [r for r in results if isinstance(r, dict)]


def _find_notion_page_for_upsert(job: JobRead) -> tuple[str | None, str | None, bool]:
    """
    Find at most one Notion page for this job.

    Returns ``(page_id, match_reason, ambiguous)`` where ``match_reason`` is
    ``\"linkedin_job_id\"``, ``\"job_url\"``, or ``None``;
    ``ambiguous`` is True if a dimension matched **more than one** row (caller should CREATE).
    """
    job = materialize_job_read(job)
    li = (job.linkedin_job_id or "").strip()
    if li:
        r = _query_notion_pages_by_linkedin_job_id_exact(li)
        if len(r) > 1:
            return None, None, True
        if len(r) == 1:
            return r[0]["id"], "linkedin_job_id", False
    uv = (job.source_url or "").strip()
    if uv:
        r = _query_notion_pages_by_source_url_exact(uv)
        if len(r) > 1:
            return None, None, True
        if len(r) == 1:
            return r[0]["id"], "job_url", False
    return None, None, False


def update_existing_page(page_id: str, job: JobRead) -> requests.Response:
    """PATCH an existing Notion page with upsert row fields (base job row)."""
    job = materialize_job_read(job)
    props = _notion_upsert_row_properties(job)
    resp = notion_patch_page_properties(page_id, props)
    if resp.status_code == 400 and "Job URL" in (resp.text or ""):
        props_retry = {k: v for k, v in props.items() if k != "Job URL"}
        resp = notion_patch_page_properties(page_id, props_retry)
    if resp.status_code == 400 and "Linkedin Job ID" in (resp.text or ""):
        props_retry = {k: v for k, v in props.items() if k != "Linkedin Job ID"}
        resp = notion_patch_page_properties(page_id, props_retry)
    return resp


def create_new_page(job: JobRead) -> requests.Response:
    """
    POST a new Notion database row for this job.

    This is the only function that issues Notion ``POST /v1/pages`` to create the base job row.
    """
    job = materialize_job_read(job)
    url = "https://api.notion.com/v1/pages"
    body = job_to_notion_page_payload(job)
    parent = body.get("parent") or {}
    _db = parent.get("database_id") or ""
    _log_notion_request_database_id(str(_db), "POST /v1/pages parent.database_id")
    resp = requests.post(url, headers=_notion_headers(), json=body, timeout=20)
    return resp


def job_to_notion_page_payload(job: JobRead, *, database_id: str | None = None) -> dict[str, Any]:
    """
    Map a scored :class:`JobRead` to a Notion API `create page` body (database parent).

    Adjust property keys (\"Name\", \"Company\", …) to match your database columns.
    """
    job = materialize_job_read(job)
    db_id = (
        (database_id or "").strip()
        or _notion_database_id_from_env()
        or f"<{NOTION_ENV_DATABASE_ID}>"
    )
    row_title = f"{job.title} @ {job.company}"

    role = job.role_family.value if job.role_family else ""
    resume_id = job.recommended_resume_variant.value if job.recommended_resume_variant else ""
    resume_select = RESUME_VARIANT_SELECT_NAME.get(resume_id, "")
    decision = job.decision or ""

    props: dict[str, Any] = {
        "Name": _title(row_title),
        "Company": _rich_text(job.company),
        "Title": _rich_text(job.title),
        "Location": _rich_text(job.location),
        "Job URL": _url(job.source_url),
        "Status": _select(job.status.value),
        "Fit score": _number(job.fit_score),
        "Decision": _select(decision),
        "Role family": _select(role),
        "Resume variant": _select(resume_select),
        "Open-ended questions": {"checkbox": bool(job.has_open_ended_questions)},
        "Job Copilot ID": _number(job.id),
        "Created": _date_iso(job.created_at),
        "Updated": _date_iso(job.updated_at),
    }
    li = (job.linkedin_job_id or "").strip()
    if li:
        print("[NOTION CREATE] using property: Linkedin Job ID")
        props["Linkedin Job ID"] = _rich_text(li)
    return {
        "parent": {"type": "database_id", "database_id": db_id},
        "properties": props,
    }


def notion_patch_page_properties(page_id: str, properties: dict[str, Any]) -> requests.Response:
    """PATCH https://api.notion.com/v1/pages/{page_id} with partial properties."""
    pid = (page_id or "").strip()
    url = f"https://api.notion.com/v1/pages/{pid}"
    return requests.patch(
        url,
        headers=_notion_headers(),
        json={"properties": properties},
        timeout=20,
    )


def notion_status_properties_for_job(job: JobRead) -> dict[str, Any]:
    """
    Minimal properties for status sync: ``Status`` and ``Updated`` only.

    Do not add optional columns here: if a property is missing or the wrong type in the
    Notion database, Notion rejects the whole PATCH and the row will not update.
    Row creation uses :func:`job_to_notion_page_payload` and does not include
    recommended-action fields.
    """
    job = materialize_job_read(job)
    return {
        "Status": _select(job.status.value),
        "Updated": _date_iso(job.updated_at),
    }


def sync_scored_job_to_notion(job: JobRead) -> dict[str, Any]:
    """
    Upsert a single Notion row: match **Linkedin Job ID** first (exact), else **Job URL** (exact);
    ambiguous multi-match → CREATE. Entry point for the base row (not application-package blocks).

    Call graph for a new row: ``sync_scored_job_to_notion`` → ``create_new_page`` → POST ``/v1/pages``.
    """
    try:
        job = materialize_job_read(job)
        print("[NOTION UPSERT] start sync_scored_job_to_notion", job.id)
        print(
            "[IDENTITY] linkedin_job_id:",
            getattr(job, "linkedin_job_id", None),
        )
        print("[NOTION UPSERT] source_url:", getattr(job, "source_url", None))
        print("[NOTION UPSERT] notion_page_id before:", getattr(job, "notion_page_id", None))

        if job.notion_page_id:
            print("NOTION MODE:", "skip_already_linked")
            print(
                f"[NOTION UPSERT] skip upsert: job already has notion_page_id={job.notion_page_id!r}"
            )
            return {
                "synced": True,
                "job_id": job.id,
                "notion_page_id": job.notion_page_id,
                "skipped": "already_linked",
            }

        if not notion_credentials_configured():
            print("NOTION CONFIG MISSING")
            missing = notion_missing_env_vars()
            print(
                "[NOTION UPSERT] skip: missing env:",
                ", ".join(missing))
            return {
                "synced": False,
                "error": "notion_credentials_missing",
                "job_id": job.id,
            }

        print("[NOTION UPSERT] using source_url:", job.source_url)
        url_val = (job.source_url or "").strip()
        li_val = (job.linkedin_job_id or "").strip()

        def _finish_create(resp: requests.Response) -> dict[str, Any]:
            print("NOTION MODE:", "create")
            print("[NOTION UPSERT] create HTTP status:", resp.status_code)
            response_json = _parse_notion_response_json(resp)
            if response_json is not None:
                print("NOTION RESPONSE:", json.dumps(response_json, default=str)[:12000])
            if not (200 <= resp.status_code < 300):
                err_detail = (
                    response_json.get("message", resp.text)
                    if response_json
                    else resp.text
                )
                raise RuntimeError(
                    f"Notion CREATE failed: {resp.status_code} {err_detail}"
                )
            if response_json is None:
                raise RuntimeError(
                    f"Notion CREATE returned non-JSON response: {resp.text!r}"
                )
            page_id = response_json.get("id")
            if not page_id:
                print("NOTION ERROR: missing id in create response JSON")
                raise Exception("Notion page creation failed")
            print(f"[NOTION UPSERT] extracted page_id from create: {page_id}")
            return {
                "synced": True,
                "job_id": job.id,
                "notion_page_id": page_id,
                "upsert": "created",
            }

        def _finish_update(page_id: str) -> dict[str, Any]:
            print("NOTION MODE:", "update")
            resp = update_existing_page(page_id, job)
            print("[NOTION UPSERT] update HTTP status:", resp.status_code)
            response_json = _parse_notion_response_json(resp)
            if response_json is not None:
                print("NOTION RESPONSE:", json.dumps(response_json, default=str)[:12000])
            if not (200 <= resp.status_code < 300):
                err_detail = (
                    response_json.get("message", resp.text)
                    if response_json
                    else resp.text
                )
                raise RuntimeError(
                    f"Notion UPDATE failed: {resp.status_code} {err_detail}"
                )
            rid = (response_json or {}).get("id") if response_json else None
            if rid and rid != page_id:
                print("[NOTION UPSERT] warning: PATCH response id != page_id", rid, page_id)
            return {
                "synced": True,
                "job_id": job.id,
                "notion_page_id": page_id,
                "upsert": "updated",
            }

        page_hit, match_reason, ambiguous = _find_notion_page_for_upsert(job)
        if ambiguous:
            print(
                "[NOTION UPSERT] forcing CREATE because no unique match "
                "(ambiguous Notion rows for LinkedIn id or Job URL)"
            )
            return _finish_create(create_new_page(job))

        if page_hit and match_reason == "linkedin_job_id":
            print("[NOTION MATCH] matched by linkedin_job_id")
            return _finish_update(page_hit)

        if page_hit and match_reason == "job_url":
            print("[NOTION MATCH] matched by Job URL")
            return _finish_update(page_hit)

        if not li_val and not url_val:
            print(
                "[NOTION UPSERT] forcing CREATE because source_url is missing (skip search)"
            )
            return _finish_create(create_new_page(job))

        print("[NOTION UPSERT] branch: CREATE (no existing Notion row for identity)")
        return _finish_create(create_new_page(job))
    except Exception as e:
        print("[NOTION UPSERT] exception:", repr(e))
        traceback.print_exc()
        raise


def preview_notion_payload_for_job(job: JobRead) -> dict[str, Any]:
    """Same mapping as sync would use; intended for API preview / debugging."""
    return job_to_notion_page_payload(job)


def sync_application_package_to_notion(
    job: JobRead, package: ApplicationPackageResponse
) -> None:
    """
    Append Fit Summary and Talking Points to the existing Notion page as blocks (does not create pages).
    """
    print("🔥 Notion sync started")
    print("Page ID:", job.notion_page_id)
    if not job.notion_page_id:
        return

    next_move_text = (package.application_strategy or "").strip() or "Review Manually"
    content: list[dict[str, Any]] = [
        {
            "object": "block",
            "type": "heading_2",
            "heading_2": {
                "rich_text": [
                    {"type": "text", "text": {"content": "Next Move"}}
                ],
            },
        },
        {
            "object": "block",
            "type": "bulleted_list_item",
            "bulleted_list_item": {
                "rich_text": [
                    {"type": "text", "text": {"content": next_move_text[:2000]}}
                ],
            },
        },
        {
            "object": "block",
            "type": "heading_2",
            "heading_2": {
                "rich_text": [
                    {"type": "text", "text": {"content": "Fit Summary"}}
                ],
            },
        },
    ]
    for line in package.fit_summary:
        text = line.strip()
        if text.startswith("•"):
            text = text[1:].strip()
        if not text:
            continue
        content.append(
            {
                "object": "block",
                "type": "bulleted_list_item",
                "bulleted_list_item": {
                    "rich_text": [
                        {"type": "text", "text": {"content": text[:2000]}}
                    ],
                },
            }
        )
    content.append(
        {
            "object": "block",
            "type": "heading_2",
            "heading_2": {
                "rich_text": [
                    {"type": "text", "text": {"content": "Talking Points"}}
                ],
            },
        }
    )
    for t in package.talking_points:
        text = t.strip()
        if text.startswith("•"):
            text = text[1:].strip()
        if not text:
            continue
        content.append(
            {
                "object": "block",
                "type": "bulleted_list_item",
                "bulleted_list_item": {
                    "rich_text": [
                        {"type": "text", "text": {"content": text[:2000]}}
                    ],
                },
            }
        )

    if len(content) <= 2:
        return

    print("APPEND URL:", f"https://api.notion.com/v1/blocks/{job.notion_page_id}/children")
    response = requests.patch(
        f"https://api.notion.com/v1/blocks/{job.notion_page_id}/children",
        headers=_notion_headers(),
        json={"children": content},
    )
    print("🔥 Notion status:", response.status_code)
    print("🔥 Notion response:", response.text)


def update_notion_job_status(job: JobRead) -> dict[str, Any]:
    """
    PATCH the existing Notion page: update ``Status`` (and ``Updated``) only.

    Resolves the page via ``linkedin_job_id`` / Job URL when ``notion_page_id`` is missing.
    """
    job = materialize_job_read(job)
    page_id = (job.notion_page_id or "").strip() or None
    resolved_from_identity = False

    print("[STATUS SYNC] job_id:", job.id)
    print("[STATUS SYNC] new status:", job.status.value)
    print("[STATUS SYNC] notion_page_id:", page_id)

    if not notion_credentials_configured():
        print("NOTION CONFIG MISSING")
        missing = notion_missing_env_vars()
        print(
            "[STATUS SYNC] skipping: missing env:",
            ", ".join(missing),
        )
        return {
            "updated": False,
            "reason": "notion_credentials_missing",
            "job_id": job.id,
            "status": job.status.value,
            "resolved_notion_page_id": None,
        }

    if not page_id:
        print("[STATUS SYNC] missing notion_page_id; resolving via LinkedIn Job ID / Job URL")
        print(
            "[IDENTITY] linkedin_job_id:",
            getattr(job, "linkedin_job_id", None),
        )
        pid, reason, amb = _find_notion_page_for_upsert(job)
        if amb or not pid:
            print("[STATUS SYNC] missing notion_page_id (could not resolve Notion page)")
            return {
                "updated": False,
                "reason": "notion_page_unresolved",
                "job_id": job.id,
                "status": job.status.value,
                "resolved_notion_page_id": None,
            }
        page_id = pid
        resolved_from_identity = True
        if reason == "linkedin_job_id":
            print("[NOTION MATCH] matched by linkedin_job_id")
        elif reason == "job_url":
            print("[NOTION MATCH] matched by Job URL")

    props = notion_status_properties_for_job(job)
    print("[STATUS SYNC] updating notion page:", page_id)
    print("[STATUS SYNC] status payload:", props)

    try:
        resp = notion_patch_page_properties(page_id, props)
    except requests.RequestException as e:
        print("[STATUS SYNC] response status: <request exception>")
        print("[STATUS SYNC] response body:", str(e))
        return {
            "updated": False,
            "error": str(e),
            "job_id": job.id,
            "status": job.status.value,
            "resolved_notion_page_id": page_id if resolved_from_identity else None,
        }

    print("[STATUS SYNC] response status:", resp.status_code)
    print("[STATUS SYNC] response body:", resp.text)

    if 200 <= resp.status_code < 300:
        out: dict[str, Any] = {
            "updated": True,
            "job_id": job.id,
            "status": job.status.value,
            "notion_page_id": page_id,
            "resolved_notion_page_id": page_id if resolved_from_identity else None,
        }
        return out

    try:
        err_json = resp.json()
    except ValueError:
        err_json = None

    if isinstance(err_json, dict):
        msg = err_json.get("message") or err_json.get("error") or resp.text
    else:
        msg = resp.text

    return {
        "updated": False,
        "error": f"{resp.status_code}: {msg}",
        "job_id": job.id,
        "status": job.status.value,
        "resolved_notion_page_id": page_id if resolved_from_identity else None,
    }
