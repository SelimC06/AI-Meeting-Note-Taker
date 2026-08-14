"""Two-pass knowledge extraction from one meeting's notes.

Exactly two Ollama calls per meeting, both using structured outputs
(format=<pydantic schema>, constrained decoding) so the response is
schema-valid by construction rather than by prompt instruction:

1. extract_pass  -- entities + index-based relations.
2. verify_pass   -- batched reflection: every extracted triple judged
   TRUE/FALSE against the notes; FALSE relations removed. The only
   measured defense against relations the notes explicitly negate
   (prompt-level fixes were tried in prototyping and did not work).

No gleaning pass (cut in the lean v2 design): single-pass recall gaps are
covered at retrieval time by the keyword side of hybrid retrieval.

Transport errors (Ollama down, timeout) intentionally propagate to the
caller -- graph_jobs' worker backstop logs them and leaves the session
unindexed for the next backfill retry. Only schema-validation failures are
absorbed here, per the design's error-handling table.
"""
from __future__ import annotations

import os
from typing import List, Literal

from pydantic import BaseModel, ValidationError

from . import ollama_client

OLLAMA_BASE = ollama_client.resolve_ollama_base()
OLLAMA_TIMEOUT_SECONDS = ollama_client.resolve_timeout_seconds("graph_extract")
_client = ollama_client.make_generation_client(OLLAMA_BASE, OLLAMA_TIMEOUT_SECONDS)

EntityType = Literal["person", "project", "decision", "action_item", "topic", "organization"]


class Entity(BaseModel):
    id: int  # position in THIS response's entities array, not a graph-wide id
    type: EntityType
    name: str
    aliases: List[str] = []


class Relation(BaseModel):
    source_id: int  # references an Entity.id in the same response
    relation: str
    target_id: int


class Extraction(BaseModel):
    entities: List[Entity] = []
    relations: List[Relation] = []


class Verdicts(BaseModel):
    verdicts: List[bool]


EXTRACT_SYSTEM_PROMPT = (
    "You extract structured facts from one meeting's notes.\n"
    "\"id\" is the entity's position in the entities array, starting at 0. "
    "Every relation's source_id/target_id MUST refer to an id in the "
    "entities array.\n"
    "IMPORTANT: include EVERY person named in the notes, even mentioned "
    "once. ALSO include the meeting's central subject/project/topic as its "
    "own entity, not just inside relation text.\n"
    "Entity names should be the SHORTEST natural form (e.g. a person's "
    "first name); if an entity is referred to multiple ways, put the "
    "primary form as 'name' and other forms in 'aliases'.\n"
    "Do not invent facts not present in the notes."
)

VERIFY_SYSTEM_PROMPT = (
    "You are verifying claims extracted from one meeting's notes.\n"
    "For EACH numbered claim, answer true if the notes actually support "
    "it, false if they do not (including claims the notes explicitly "
    "negate, attribute to the wrong person, or never state).\n"
    "Return exactly one verdict per claim, in the same order."
)

_EXTRACT_OPTIONS = {"temperature": 0.2, "num_predict": 900, "num_ctx": 4096, "num_gpu": 0}
_VERIFY_OPTIONS = {"temperature": 0.2, "num_predict": 300, "num_ctx": 4096, "num_gpu": 0}


def resolve_graph_model(chat_model: str) -> str:
    """The graph runs on the user's chat model unless GRAPH_MODEL is set."""
    return os.getenv("GRAPH_MODEL") or chat_model


def extract_pass(notes: str, model: str) -> Extraction:
    resp = _client.chat(
        model=model,
        messages=[
            {"role": "system", "content": EXTRACT_SYSTEM_PROMPT},
            {"role": "user", "content": f'Meeting notes:\n"""\n{notes}\n"""'},
        ],
        format=Extraction.model_json_schema(),
        options=_EXTRACT_OPTIONS,
        stream=False,
    )
    return Extraction.model_validate_json(resp["message"]["content"])


def verify_pass(notes: str, extraction: Extraction, model: str) -> Extraction:
    if not extraction.relations:
        return extraction
    names = {e.id: e.name for e in extraction.entities}
    claims = "\n".join(
        f"{i}. {names.get(r.source_id, '?')} -- {r.relation} -- {names.get(r.target_id, '?')}"
        for i, r in enumerate(extraction.relations, 1)
    )
    resp = _client.chat(
        model=model,
        messages=[
            {"role": "system", "content": VERIFY_SYSTEM_PROMPT},
            {"role": "user", "content": f'Meeting notes:\n"""\n{notes}\n"""\n\nClaims:\n{claims}'},
        ],
        format=Verdicts.model_json_schema(),
        options=_VERIFY_OPTIONS,
        stream=False,
    )
    verdicts = Verdicts.model_validate_json(resp["message"]["content"]).verdicts
    if len(verdicts) != len(extraction.relations):
        # Shape mismatch: fall back to approving everything rather than
        # guessing which verdict belongs to which claim.
        return extraction
    kept = [r for r, ok in zip(extraction.relations, verdicts) if ok]
    return Extraction(entities=extraction.entities, relations=kept)


def extract_from_notes(notes: str, model: str) -> Extraction:
    """Run both passes. Schema failures degrade per the design's table:
    extract failing -> empty Extraction (session stays unindexed, retried
    by backfill); verify failing -> unverified extraction passes through.
    """
    try:
        extraction = extract_pass(notes, model)
    except (ValidationError, ValueError):
        return Extraction()
    try:
        return verify_pass(notes, extraction, model)
    except (ValidationError, ValueError):
        return extraction
