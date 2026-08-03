from __future__ import annotations
import os
import re
from typing import Iterator, List, Dict

import ollama

OLLAMA_BASE = os.getenv("OLLAMA_BASE_URL") or os.getenv("OLLAMA_HOST") or "http://localhost:11434"
DEFAULT_MODEL = os.getenv("OLLAMA_VISION_MODEL", "llava:7b-v1.5-q4_K_M")

_client = ollama.Client(host=OLLAMA_BASE)

# How many characters (or until the first blank line, whichever comes first)
# to buffer before deciding whether the response opens with a title-style
# preamble. Small local models sometimes prepend one out of habit regardless
# of prompt instructions; this can't be reliably prevented by prompting, so
# it's sanitized out of the output deterministically instead.
_PREAMBLE_BUFFER_CHARS = 300

# Matches a leading "🔥 Title: ... \n----" style preamble: an optional
# symbol/emoji, an optional markdown heading marker, an optional literal
# "Title:", a line of text, then a line of dashes/underscores/rule
# characters. Stripped once, from the very start of the response only.
_TITLE_PREAMBLE_RE = re.compile(
    r"^\s*(?:[^\w\s]{1,4}\s*)?(?:#+\s*)?(?:title:?\s*)?.*?\n[-_=─—]{3,}\s*\n+",
    re.IGNORECASE,
)


def assert_ollama_up() -> None:
    """Quick connectivity check; raises if the local Ollama server isn't up."""
    _client.list()


def _strip_heading(notes: str) -> str:
    """Drop a leading Markdown '# ' title heading from notes.

    Reduces the chance the model has an exact title available to copy —
    complementary to, not a substitute for, stripping the model's own
    output preamble below (the model can still generate a title-style
    preamble out of habit even with nothing to copy from).
    """
    lines = notes.splitlines()
    if lines and lines[0].strip().startswith("# "):
        lines = lines[1:]
    return "\n".join(lines).lstrip("\n")


def _strip_title_preamble(text: str) -> str:
    """Remove a leading title-style preamble from a model response.

    Some local models open responses with a "Title: ... ----" style header
    out of habit, independent of what the prompt asks for — this has been
    observed even with an explicit instruction not to do it. Since that
    can't be reliably prevented by prompting, it's stripped deterministically
    from the output instead.
    """
    return _TITLE_PREAMBLE_RE.sub("", text, count=1)


def stream_chat_reply(
    notes: str,
    message: str,
    history: List[Dict[str, str]],
    model: str = DEFAULT_MODEL,
    temperature: float = 0.3,
    num_ctx: int = 8192,
    num_predict: int = 800,
) -> Iterator[str]:
    """Yield response text chunks for one chat turn about a single meeting.

    `notes` is that meeting's stored notes (the only context the model gets —
    no raw transcript). `history` is the prior conversation turns as
    {"role": "user"|"assistant", "content": str} dicts, oldest first.
    """
    system_prompt = (
        "You are answering questions about ONE specific recorded meeting, "
        "in a normal spoken conversational tone.\n"
        "Below are that meeting's notes, for reference only.\n"
        "- Never paste, quote, or reproduce the notes verbatim or in their "
        "original structure (no Markdown headings, bullet lists, or "
        "horizontal rules in your answer).\n"
        "- Answer in plain prose sentences, synthesizing only the part of "
        "the notes relevant to the question asked — do not summarize the "
        "whole meeting unless asked to.\n"
        "- If the answer isn't in the notes, say so plainly instead of "
        "guessing or inventing details.\n"
        "- Keep answers concise — a few sentences, not a report.\n\n"
        f"Meeting notes (reference only, do not repeat verbatim):\n\"\"\"\n{_strip_heading(notes)}\n\"\"\""
    )

    messages: List[Dict[str, str]] = [{"role": "system", "content": system_prompt}]
    messages.extend(history)
    messages.append({"role": "user", "content": message})

    options = {
        "temperature": float(temperature),
        "num_predict": int(num_predict),
        "num_ctx": int(num_ctx),
        "num_gpu": 0,
    }

    buffer = ""
    buffering = True

    for chunk in _client.chat(model=model, messages=messages, options=options, stream=True):
        delta = chunk.get("message", {}).get("content", "")
        if not delta:
            continue

        if buffering:
            buffer += delta
            if "\n\n" in buffer or len(buffer) >= _PREAMBLE_BUFFER_CHARS:
                buffering = False
                cleaned = _strip_title_preamble(buffer)
                if cleaned:
                    yield cleaned
                buffer = ""
            continue

        yield delta

    if buffering and buffer:
        yield _strip_title_preamble(buffer)
