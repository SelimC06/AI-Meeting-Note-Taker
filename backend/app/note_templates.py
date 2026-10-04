"""Note templates by meeting type (Tier 2.3).

Each template is the Markdown skeleton the summarizer fills (see
LLaVA_summarize.complete, which injects the body under "Template:").
Users pick one in Settings > Notes, or select "custom" and edit their own
body. Every body starts with the parenthesized title placeholder so the
real-titles contract (sessions_store.extract_title and the summarizer's
title rule) holds for every type.
"""
from __future__ import annotations

from typing import Dict, List, Optional

TITLE_LINE = "# (specific 3-6 word meeting title)\n"

BUILTIN_TEMPLATES: List[Dict[str, str]] = [
    {
        "id": "general",
        "label": "General",
        "description": "Any meeting — key points, decisions, actions",
        "body": (
            TITLE_LINE
            + "- One-liner purpose of meeting\n\n"
            "## Key Points\n- (bullet)\n- (bullet)\n\n"
            "## Decisions\n- (decision)\n\n"
            "## Action Items\n- (action)\n\n"
            "## Open Questions\n- (question)\n\n"
            "## Timeline / Dates Mentioned\n- (item)\n"
        ),
    },
    {
        "id": "one_on_one",
        "label": "1:1",
        "description": "Manager/report or peer check-in",
        "body": (
            TITLE_LINE
            + "- One-liner on what this 1:1 focused on\n\n"
            "## Updates Since Last Time\n- (update)\n\n"
            "## Wins\n- (win)\n\n"
            "## Challenges / Blockers\n- (challenge, and any help asked for)\n\n"
            "## Feedback Exchanged\n- (feedback, noting who gave it)\n\n"
            "## Growth & Career Notes\n- (item)\n\n"
            "## Action Items\n- (action, with owner)\n\n"
            "## For Next 1:1\n- (topic to revisit)\n"
        ),
    },
    {
        "id": "standup",
        "label": "Standup",
        "description": "Daily sync — per-person updates and blockers",
        "body": (
            TITLE_LINE
            + "- One-liner (team / sprint context if stated)\n\n"
            "## Updates by Person\n- (name: what they did / what's next)\n\n"
            "## Blockers\n- (blocker, who is blocked, who can unblock)\n\n"
            "## Decisions\n- (decision)\n\n"
            "## Action Items\n- (action, with owner)\n"
        ),
    },
    {
        "id": "interview",
        "label": "Interview",
        "description": "Candidate conversation — signals and verdict",
        "body": (
            TITLE_LINE
            + "- One-liner: candidate and role (as stated)\n\n"
            "## Background Highlights\n- (experience, projects, skills mentioned)\n\n"
            "## Assessment Signals\n- (answer or moment, and what it showed)\n\n"
            "## Strengths\n- (strength)\n\n"
            "## Concerns\n- (concern or gap)\n\n"
            "## Candidate's Questions\n- (what they asked)\n\n"
            "## Next Steps\n- (follow-up, with owner)\n"
        ),
    },
    {
        "id": "sales",
        "label": "Sales",
        "description": "Customer call — needs, objections, next steps",
        "body": (
            TITLE_LINE
            + "- One-liner: company, attendees, and deal stage if stated\n\n"
            "## Needs & Pain Points\n- (need, in the customer's words)\n\n"
            "## Current Solution / Alternatives\n- (what they use today)\n\n"
            "## Objections & Concerns\n- (objection, and any response given)\n\n"
            "## Pricing & Budget Notes\n- (item)\n\n"
            "## Next Steps\n- (commitment, with owner and date)\n"
        ),
    },
]

BUILTIN_TEMPLATE_IDS = {t["id"] for t in BUILTIN_TEMPLATES}
# "custom" selects the user-edited body stored in settings.
TEMPLATE_IDS = BUILTIN_TEMPLATE_IDS | {"custom"}

DEFAULT_TEMPLATE_ID = "general"
DEFAULT_TEMPLATE_BODY = BUILTIN_TEMPLATES[0]["body"]

# A runaway custom body would eat the transcript's context budget (see
# complete()'s overhead math); PATCH /settings enforces this.
MAX_CUSTOM_TEMPLATE_CHARS = 4000


def resolve_template_body(template_id: Optional[str], custom_body: Optional[str]) -> str:
    """The Markdown skeleton a job should summarize into.

    Unknown ids (an old job snapshot, a hand-edited settings file) and an
    empty custom body both fall back to the general template -- a summary
    must never fail over template bookkeeping."""
    if template_id == "custom":
        body = (custom_body or "").strip()
        return body + "\n" if body else DEFAULT_TEMPLATE_BODY
    for template in BUILTIN_TEMPLATES:
        if template["id"] == template_id:
            return template["body"]
    return DEFAULT_TEMPLATE_BODY


def public_choices() -> List[Dict[str, str]]:
    """What GET /settings serves the UI: id, label, description, and the
    body (shown as a preview, and the prefill for 'edit as custom')."""
    return [dict(t) for t in BUILTIN_TEMPLATES]
