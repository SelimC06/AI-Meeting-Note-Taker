"""Streaming chat over MULTIPLE meetings' notes.

Same streaming, buffering, and title-preamble-stripping conventions as
chat.stream_chat_reply (the preamble habit is a property of the local
model, not of the single-meeting prompt) -- the shared pieces are imported
from chat.py rather than duplicated so the two paths can't drift.
"""
from __future__ import annotations

from typing import Dict, Iterator, List

from .chat import DEFAULT_MODEL, _PREAMBLE_BUFFER_CHARS, _client, _strip_title_preamble


def stream_graph_chat_reply(
    context: str,
    message: str,
    history: List[Dict[str, str]],
    model: str = DEFAULT_MODEL,
    temperature: float = 0.3,
    num_ctx: int = 8192,
    num_predict: int = 800,
) -> Iterator[str]:
    """Yield response chunks for one cross-meeting chat turn.

    `context` is the labeled multi-meeting notes block built by
    graph_retrieve.build_context. `history` is prior turns as
    {"role": "user"|"assistant", "content": str} dicts, oldest first.
    """
    system_prompt = (
        "You are answering questions that may span MULTIPLE recorded "
        "meetings, in a normal spoken conversational tone.\n"
        "Below are the notes of the meetings judged most relevant to the "
        "question, each labeled with its title and date.\n"
        "- Answer in plain prose, synthesizing across meetings as needed "
        "-- never paste, quote, or reproduce the notes verbatim or in "
        "their original structure.\n"
        "- When your answer draws on a specific meeting, mention that "
        "meeting's title naturally in the sentence (e.g. \"In the Design "
        "Review Sync, ...\").\n"
        "- If the answer isn't in the provided notes, say so plainly "
        "instead of guessing or inventing details.\n"
        "- Keep answers concise -- a few sentences, not a report.\n\n"
        f"Meeting notes (reference only, do not repeat verbatim):\n\"\"\"\n{context}\n\"\"\""
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
