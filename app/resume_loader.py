"""
Resume loader — reads PDF resume variants from the resumes/ folder at startup.

Each PDF becomes a named variant. The filename (without .pdf) is the variant key.
Example:
    resumes/finance_ops.pdf     → variant key "finance_ops"
    resumes/leadership.pdf      → variant key "leadership"

Usage:
    from app.resume_loader import get_resumes, get_resume_display_name

    resumes = get_resumes()   # dict[str, str]  key → extracted text
    display = get_resume_display_name("strategic_ops")  # "finance_ops" (from YAML mapping)
"""

from __future__ import annotations

from pathlib import Path
from functools import lru_cache
from typing import Optional

import yaml

RESUMES_DIR = Path(__file__).resolve().parent.parent / "resumes"
CONFIG_PATH = Path(__file__).resolve().parent.parent / "app_config.yaml"

_resume_cache: dict[str, str] | None = None


def load_resumes() -> dict[str, str]:
    """
    Read all PDFs from the resumes/ folder and extract their text.
    Returns dict of {variant_key: extracted_text}.
    Fails loudly at startup if no resumes are found.
    """
    if not RESUMES_DIR.exists():
        print(
            f"[RESUMES] ⚠️  No 'resumes/' folder found at {RESUMES_DIR}. "
            "Create it and add at least one PDF resume."
        )
        return {}

    pdf_files = sorted(RESUMES_DIR.glob("*.pdf"))
    if not pdf_files:
        print(
            "[RESUMES] ⚠️  The 'resumes/' folder exists but contains no PDFs. "
            "Add at least one resume PDF."
        )
        return {}

    try:
        import pdfplumber
    except ImportError:
        print(
            "[RESUMES] ⚠️  pdfplumber is not installed. "
            "Run: pip install pdfplumber --break-system-packages\n"
            "Resume PDFs will not be loaded until pdfplumber is available."
        )
        return {}

    results: dict[str, str] = {}
    for pdf_path in pdf_files:
        key = pdf_path.stem  # filename without .pdf
        try:
            text = ""
            with pdfplumber.open(pdf_path) as pdf:
                for page in pdf.pages:
                    page_text = page.extract_text()
                    if page_text:
                        text += page_text + "\n"
            results[key] = text.strip()
            print(f"[RESUMES] ✓ Loaded: {key} ({len(text):,} chars)")
        except Exception as e:
            print(f"[RESUMES] ✗ Failed to read {pdf_path.name}: {e}")

    return results


def get_resumes() -> dict[str, str]:
    """Return cached resume variants. Loads on first call."""
    global _resume_cache
    if _resume_cache is None:
        _resume_cache = load_resumes()
    return _resume_cache


@lru_cache(maxsize=1)
def _load_resume_mapping() -> dict[str, str]:
    """
    Read resume_mapping from app_config.yaml.
    Maps scoring role keys → tester's PDF basenames.
    e.g. {"strategic_ops": "finance_ops", "revops": "finance_ops", "default": "main_resume"}
    """
    try:
        raw = yaml.safe_load(CONFIG_PATH.read_text(encoding="utf-8"))
        mapping = raw.get("resume_mapping") or {}
        # Filter out empty values
        return {k: v for k, v in mapping.items() if v and str(v).strip()}
    except Exception as e:
        print(f"[RESUMES] Could not load resume_mapping from config: {e}")
        return {}


def get_resume_display_name(role_key: str) -> Optional[str]:
    """
    Translate a scoring role key (e.g. "strategic_ops") to the tester's
    configured PDF filename (e.g. "finance_ops").

    Returns None if no mapping is configured for this role.

    Role keys: "strategic_ops", "revops", "chief_of_staff", "cx_enablement", "default"
    """
    mapping = _load_resume_mapping()
    if not mapping:
        return None
    # Try exact match first, then fall back to "default"
    result = mapping.get(role_key) or mapping.get("default")
    return result or None


def has_resumes_configured() -> bool:
    """True if at least one resume PDF has been loaded."""
    return bool(get_resumes())
