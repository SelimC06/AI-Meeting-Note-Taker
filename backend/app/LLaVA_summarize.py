from pathlib import Path
import base64, io, json, os, re
from PIL import Image
from typing import List, Optional

from . import ollama_client

OLLAMA_BASE = ollama_client.resolve_ollama_base()
# Summarization is text-only in practice (server.py never passes
# frame_paths), so it shares the same configurable chat model by default
# instead of a hardcoded vision model. OLLAMA_VISION_MODEL is kept as an
# explicit override for the rare case someone does want frame-based
# (screenshot) summarization later, but it's no longer the silent default.
DEFAULT_MODEL = os.getenv("OLLAMA_VISION_MODEL", os.getenv("OLLAMA_CHAT_MODEL", "gemma3:4b"))

# Health checks get a short, fixed timeout; the generation call gets a
# generous, configurable one (local vision models can take minutes to
# produce a first token after a cold load).
OLLAMA_TIMEOUT_SECONDS = ollama_client.resolve_timeout_seconds("LLaVA_summarize")

_client = ollama_client.make_generation_client(OLLAMA_BASE, OLLAMA_TIMEOUT_SECONDS)
# Separate instance from _client so the health check's short timeout can never
# be affected by (or fight with) whatever timeout the generation call needs.
_health_client = ollama_client.make_health_client(OLLAMA_BASE)

def _assert_ollama_up():
    # Quick connectivity check; will raise if server isn’t up
    _health_client.list()

def _img_to_b64_resized(path: str, max_px: int = 640, jpeg_quality: int = 70) -> str:
    with Image.open(path) as im:
        im = im.convert("RGB")
        w, h = im.size
        scale = max(w, h) / float(max_px)
        if scale > 1.0:
            im = im.resize((int(round(w/scale)), int(round(h/scale))), Image.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, format="JPEG", quality=jpeg_quality, optimize=True)
        return base64.b64encode(buf.getvalue()).decode("utf-8")

# --- Long-transcript chunking ------------------------------------------
#
# A transcript used to be cut at a fixed 12000 chars before summarizing,
# which is only the first ~13-15 minutes of speech: in a 1-hour meeting the
# notes, the action items, and everything downstream of the notes (per-
# meeting chat, knowledge-graph extraction) silently ignored ~75% of it.
# Instead, a transcript that doesn't fit one call is split into chunks that
# do, each chunk is summarized/extracted on its own ("map"), and the partial
# results are combined ("reduce"). A transcript that fits takes exactly the
# single-call path it always did.

# Conservative chars-per-token for sizing chunks. English prose averages
# ~4, but speaker labels, names, numbers and non-English speech tokenize
# worse -- underestimating here just means one extra chunk, overestimating
# means Ollama silently cuts the prompt again, which is the bug being fixed.
_CHARS_PER_TOKEN = 3
# Headroom for chat-template tokens and tokenizer variance on top of the
# measured prompt overhead.
_CONTEXT_SAFETY_TOKENS = 256
# Never size a chunk below this, even with a tiny num_ctx -- a handful of
# lines per call would just produce a pile of near-empty partial notes.
_MIN_CHUNK_CHARS = 2000
# Upper bound on map calls for one transcript, so a pathological input
# (e.g. a recording left running overnight) can't queue hundreds of model
# calls and block the serial job worker for hours. At the default num_ctx
# this is ~15+ hours of speech; anything past it is reported, not hidden.
_MAX_CHUNKS = 48
# Bound on reduce rounds; each round shrinks the partials, so this is only
# a guard against a model that echoes its input back instead of condensing.
_MAX_REDUCE_ROUNDS = 4

_SENTENCE_END_RE = re.compile(r"(?<=[.!?])\s+")


def _transcript_char_budget(num_ctx, num_predict, prompt_overhead_chars) -> int:
    """How many transcript chars fit in one call alongside the prompt and
    the reserved output tokens, derived from the configured context so a
    bigger num_ctx automatically means fewer, larger chunks."""
    available_tokens = int(num_ctx) - int(num_predict) - _CONTEXT_SAFETY_TOKENS
    budget = available_tokens * _CHARS_PER_TOKEN - int(prompt_overhead_chars)
    return max(budget, _MIN_CHUNK_CHARS)


def _split_long_line(line: str, max_chars: int) -> List[str]:
    """Split one line that alone exceeds max_chars. Only needed for the
    legacy transcription path, which joins every Whisper segment into a
    single line -- the speaker-labelled paths write one segment per line
    and never get here. Breaks at sentence ends first, whitespace second,
    and only hard-cuts a single "word" longer than a whole chunk."""
    pieces: List[str] = []
    current = ""
    units = _SENTENCE_END_RE.split(line)
    for unit in units:
        if len(unit) > max_chars:
            words = unit.split(" ")
        else:
            words = [unit]
        for word in words:
            while len(word) > max_chars:
                if current:
                    pieces.append(current)
                    current = ""
                pieces.append(word[:max_chars])
                word = word[max_chars:]
            if not current:
                current = word
            elif len(current) + 1 + len(word) <= max_chars:
                current += " " + word
            else:
                pieces.append(current)
                current = word
    if current:
        pieces.append(current)
    return pieces


def _split_transcript(transcript: str, max_chars: int) -> List[str]:
    """Split a transcript into chunks of at most max_chars, only ever at
    line boundaries so a "Speaker: text" line (and any timestamp on it)
    is never cut in half. A single line longer than max_chars is the one
    exception, see _split_long_line."""
    if len(transcript) <= max_chars:
        return [transcript]

    chunks: List[str] = []
    current: List[str] = []
    current_len = 0
    for line in transcript.split("\n"):
        if len(line) > max_chars:
            if current:
                chunks.append("\n".join(current))
                current, current_len = [], 0
            chunks.extend(_split_long_line(line, max_chars))
            continue
        added = len(line) + (1 if current else 0)
        if current and current_len + added > max_chars:
            chunks.append("\n".join(current))
            current, current_len = [], 0
            added = len(line)
        current.append(line)
        current_len += added
    if current:
        chunks.append("\n".join(current))
    return [c for c in chunks if c.strip()]


def _cap_chunks(chunks: List[str], total_chars: int, duration_seconds=None):
    """Apply _MAX_CHUNKS. Returns (chunks_to_use, coverage_notice) where the
    notice is None when nothing was dropped. Minutes are estimated from the
    share of transcript text covered, since the plain-text transcript has
    no timestamps of its own; without a duration the notice says how much
    of the transcript was covered instead."""
    if len(chunks) <= _MAX_CHUNKS:
        return chunks, None
    kept = chunks[:_MAX_CHUNKS]
    covered_chars = sum(len(c) for c in kept)
    fraction = covered_chars / total_chars if total_chars else 1.0
    if duration_seconds:
        minutes = max(1, int(round(fraction * float(duration_seconds) / 60.0)))
        scope = f"the first ~{minutes} minutes"
    else:
        scope = f"the first ~{int(fraction * 100)}% of the transcript"
    notice = (
        f"_Note: this meeting was too long to summarize in full -- this summary "
        f"covers only {scope}. The rest of the transcript was not analyzed._"
    )
    return kept, notice


def _report(on_progress, done, total):
    # Progress is purely informational -- a broken callback must never fail
    # the summary it's reporting on.
    if on_progress is None:
        return
    try:
        on_progress(done, total)
    except Exception:
        pass


_SUMMARY_SYSTEM_PROMPT = (
    "You are a precise meeting-notes assistant.\n"
    "- Output ONLY valid Markdown.\n"
    "- The FIRST line must be '# ' followed by a specific 3-6 word title "
    "naming this meeting's actual topic (like '# Q3 budget review'). Never "
    "output the literal word 'Title' or any placeholder as the title.\n"
    "- Fill EVERY section of the template; if unknown, leave the section but put '- (none)'.\n"
    "- DO NOT quote or reproduce the transcript verbatim (no long paragraphs copied).\n"
    "- Use short bullets with concrete nouns/verbs; keep each bullet ≤ 20 words.\n"
    "- Never include the raw transcript in your answer."
)

# The title line is a parenthesized placeholder rather than the literal
# heading "Title": small models copy templates verbatim, and "# Title"
# used to become the stored name of nearly every meeting (extract_title
# also skips placeholder echoes as a backstop; see sessions_store).
_SUMMARY_TEMPLATE = ("# (specific 3-6 word meeting title)\n"
    "- One-liner purpose of meeting\n\n"
    "## Key Points\n- (bullet)\n- (bullet)\n\n"
    "## Decisions\n- (decision)\n\n"
    "## Action Items\n-(action)\n\n"
    "## Open Questions\n- (question)\n\n"
    "## Timeline / Dates Mentioned\n- (item)\n"
    )

_PARTIAL_SYSTEM_PROMPT = (
    "You are a precise meeting-notes assistant. You are given ONE PART of a "
    "longer meeting transcript; other parts are handled separately.\n"
    "- Output ONLY terse Markdown bullets under these headings: Key Points, "
    "Decisions, Action Items (with owner and due date when stated), Open "
    "Questions, Dates Mentioned.\n"
    "- Keep speaker names exactly as written in the transcript.\n"
    "- Cover the WHOLE part, start to end -- do not stop after the first topics.\n"
    "- DO NOT quote or reproduce the transcript verbatim; keep each bullet ≤ 20 words.\n"
    "- Omit a heading entirely if nothing belongs under it."
)

_MERGE_SYSTEM_PROMPT = (
    "You are a precise meeting-notes assistant. You are given partial notes "
    "taken from consecutive parts of ONE meeting, in order.\n"
    "- Combine them into condensed notes covering the whole span, keeping the "
    "same headings (Key Points, Decisions, Action Items, Open Questions, "
    "Dates Mentioned).\n"
    "- Merge duplicates; keep every distinct decision and action item.\n"
    "- Output ONLY terse Markdown bullets, each ≤ 20 words."
)


def _chat_text(active_client, model, messages, options, stream=False, on_token=None) -> str:
    if stream:
        parts = []
        for chunk in active_client.chat(model=model, messages=messages, options=options, stream=True):
            delta = chunk.get("message", {}).get("content", "")
            if delta:
                parts.append(delta)
                if on_token:
                    on_token(delta)
        return "".join(parts).strip()
    resp = active_client.chat(model=model, messages=messages, options=options, stream=False)
    return resp["message"]["content"].strip()


def _format_partials(partials: List[str], first_index: int, total: int) -> str:
    return "\n\n".join(
        f"### Part {first_index + i + 1} of {total}\n{p}" for i, p in enumerate(partials)
    )


def _reduce_partials(active_client, model, partials: List[str], budget: int, options) -> List[str]:
    """Condense partial notes until they fit one final call. Usually a
    no-op: at the default num_ctx a ~3-hour meeting's partials still fit.
    Longer ones are merged in groups of consecutive parts, preserving
    order, until they fit."""
    total = len(partials)
    for _ in range(_MAX_REDUCE_ROUNDS):
        if len(_format_partials(partials, 0, total)) <= budget or len(partials) <= 1:
            return partials
        groups: List[List[str]] = [[]]
        for p in partials:
            candidate = groups[-1] + [p]
            if groups[-1] and len(_format_partials(candidate, 0, total)) > budget:
                groups.append([p])
            else:
                groups[-1] = candidate
        if len(groups) == len(partials):
            # Every partial is already too big to pair with another --
            # merge pairs anyway so each round still halves the count.
            groups = [partials[i:i + 2] for i in range(0, len(partials), 2)]
        merged = []
        for group in groups:
            if len(group) == 1:
                merged.append(group[0])
                continue
            messages = [
                {"role": "system", "content": _MERGE_SYSTEM_PROMPT},
                {"role": "user", "content": "Partial notes, in meeting order:\n\n"
                    + _format_partials(group, 0, len(group))},
            ]
            merged.append(_chat_text(active_client, model, messages, options))
        partials = merged
    return partials


def complete(
    raw_txt_path, 
    out_path=None, 
    model=DEFAULT_MODEL, 
    frame_paths=None,      # list of image paths
    max_images=4,          # keep it small
    max_image_px=1280,     # downscale large frames
    jpeg_quality=80,       # compress
    max_chars=None,        # per-call transcript size; None = derive from num_ctx
    stream=False,          # set True to avoid “stuck” feel
    num_ctx=8192,          # give LLaVA more room
    num_predict=800,
    image_prompt: str = "Use the attached screenshots: extract on-screen text (OCR), headings, names, dates, and decisions. If a screenshot only shows part of the meeting, say so and summarize only that portion. Do not invent missing sections.",
    temperature=0.3,
    on_token=None,
    client=None,
    on_progress=None,      # on_progress(done, total) per model call on long transcripts
    duration_seconds=None, # meeting length, only used to word a coverage notice
    ):

    active_client = client if client is not None else _client
    # Ollama only: a custom provider's /models is optional (see
    # llm_provider.OpenAICompatClient.list), so its real call below is the
    # check -- and fails with the provider's real error.
    if client is None:
        _assert_ollama_up()

    transcript = Path(raw_txt_path).read_text(encoding="utf-8")

    system_prompt = _SUMMARY_SYSTEM_PROMPT
    template = _SUMMARY_TEMPLATE

    # The transcript must never push the prompt past num_ctx: Ollama then
    # silently truncates the WHOLE prompt (including the instructions and
    # template after the transcript). Size each call's transcript from the
    # configured context instead of a fixed char count.
    # +400 covers the fixed wording around the transcript (instructions,
    # the "part i of n" header, quote markers).
    overhead = len(system_prompt) + len(template) + len(image_prompt) + 400
    budget = _transcript_char_budget(num_ctx, num_predict, overhead)
    if max_chars is not None:
        budget = min(budget, int(max_chars))

    options = {
        "temperature": float(temperature),
        "num_predict": int(num_predict),
        "num_ctx": int(num_ctx),
    }

    chunks = _split_transcript(transcript, budget) if transcript else []
    coverage_notice = None
    if len(chunks) > 1:
        chunks, coverage_notice = _cap_chunks(chunks, len(transcript), duration_seconds)

    if len(chunks) > 1:
        # Map: condensed notes per chunk. +1 in the total for the final
        # combine call, so progress never reads "done" while it's running.
        total_steps = len(chunks) + 1
        partials: List[str] = []
        for i, chunk in enumerate(chunks):
            messages = [
                {"role": "system", "content": _PARTIAL_SYSTEM_PROMPT},
                {"role": "user", "content": (
                    f"This is part {i + 1} of {len(chunks)} of the meeting transcript.\n\n"
                    "Transcript part (do not quote directly):\n\"\"\"" + chunk + "\"\"\"\n"
                )},
            ]
            partials.append(_chat_text(active_client, model, messages, options))
            _report(on_progress, i + 1, total_steps)

        partials = _reduce_partials(active_client, model, partials, budget, options)
        source = (
            "Summarize the meeting into the template below. The meeting was too long "
            "for one pass, so below are notes taken from each consecutive part of it, "
            "in order -- together they cover the whole meeting. Merge duplicates and "
            "keep every distinct decision and action item.\n\n"
            "Notes by part:\n\"\"\"" + _format_partials(partials, 0, len(partials)) + "\"\"\"\n"
        )
    else:
        total_steps = None
        single = chunks[0] if chunks else ""
        if single:
            source = "Summarize the transcript into the template below.\n\nTranscript (do not quote directly):\n\"\"\"" + single + "\"\"\"\n"
        else:
            source = "No text transcript is provided. Derive the summary ONLY from the screenshots.\n"

    prompt_parts = [source]
    prompt_parts.append("Image instructions:\n" + image_prompt + "\n")
    prompt_parts.append("Template:\n" + template)
    user_prompt = "\n".join(prompt_parts)

    images: List[str] = []
    if frame_paths:
        for p in list(frame_paths)[:max_images]:
            try:
                images.append(_img_to_b64_resized(p, max_px=max_image_px, jpeg_quality=jpeg_quality))
            except Exception:
                pass

    
    messages=[
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt, **({"images": images} if images else {})},
    ]

    md = _chat_text(active_client, model, messages, options, stream=stream, on_token=on_token)
    if total_steps is not None:
        _report(on_progress, total_steps, total_steps)

    if coverage_notice:
        if md.startswith("#"):
            md = _insert_after_title(md, coverage_notice)
        else:
            md = coverage_notice + "\n\n" + md

    if out_path:
        Path(out_path).write_text(md, encoding="utf-8")

    return md


def _insert_after_title(md: str, notice: str) -> str:
    """Put the notice right under the first heading line, so extract_title()
    in server.py still finds the model's title as the first line while the
    notice is the first thing the user reads below it."""
    first, sep, rest = md.partition("\n")
    return first + "\n\n" + notice + ("\n" + rest if sep else "")


# --- Structured action items -------------------------------------------
#
# The chat model used here is a small (~4B-parameter) local model. Unlike
# `complete()`'s free-form Markdown (where drift just means an odd-looking
# bullet), a JSON contract can fail outright: the model can return prose
# wrapped around a JSON object, a code-fenced blob, truncated/invalid JSON,
# or a shape that's missing the fields we asked for. extract_action_items()
# below is built around that failure mode explicitly -- see its docstring.

_ACTION_ITEMS_SCHEMA_HINT = (
    '{"action_items": [{"text": "string, required", '
    '"owner": "string or null", "due": "string or null"}]}'
)

_FENCED_JSON_RE = re.compile(r"```(?:json)?\s*(\{.*\})\s*```", re.DOTALL | re.IGNORECASE)


def _extract_json_object(text: str) -> Optional[str]:
    """Best-effort: pull a single {...} JSON object out of `text`, which may
    have prose or a markdown code fence around it -- a small local model
    asked for "only JSON" frequently doesn't comply literally."""
    text = text.strip()
    fenced = _FENCED_JSON_RE.search(text)
    if fenced:
        return fenced.group(1)
    start = text.find("{")
    end = text.rfind("}")
    if start != -1 and end != -1 and end > start:
        return text[start:end + 1]
    return None


def _parse_action_items(raw_content: str) -> Optional[List[dict]]:
    """Parse the model's action-items response into a list of
    {"text", "owner", "due"} dicts.

    Returns None (never raises) on ANY shape of failure -- unparseable JSON,
    JSON that isn't an object, a missing/non-list "action_items" key, or an
    entry with no usable text -- so the caller can treat "None" uniformly as
    "this attempt didn't produce usable structured data" regardless of which
    way the small model's output went wrong.
    """
    candidate = _extract_json_object(raw_content)
    if candidate is None:
        return None
    try:
        data = json.loads(candidate)
    except (ValueError, TypeError):
        return None
    if not isinstance(data, dict):
        return None
    items = data.get("action_items")
    if not isinstance(items, list):
        return None

    parsed: List[dict] = []
    for item in items:
        if isinstance(item, str):
            text = item.strip()
            if text:
                parsed.append({"text": text, "owner": None, "due": None})
            continue
        if not isinstance(item, dict):
            continue
        text = item.get("text")
        if not isinstance(text, str) or not text.strip():
            continue
        owner = item.get("owner")
        due = item.get("due")
        parsed.append({
            "text": text.strip(),
            "owner": owner.strip() if isinstance(owner, str) and owner.strip() else None,
            "due": due.strip() if isinstance(due, str) and due.strip() else None,
        })
    return parsed


_DEDUPE_STRIP_RE = re.compile(r"[^\w\s]")


def _dedupe_key(text: str) -> str:
    return " ".join(_DEDUPE_STRIP_RE.sub(" ", text.lower()).split())


def _merge_action_items(per_chunk: List[List[dict]]) -> List[dict]:
    """Combine per-chunk action items in meeting order, dropping repeats.

    Chunks don't overlap, so a duplicate means the item was genuinely said
    twice (typically assigned mid-meeting, then restated in the wrap-up).
    Matching is deliberately exact after normalizing case/punctuation/
    whitespace rather than a fuzzy or model-based merge: a false merge
    would silently lose a real action item, a missed one just shows a
    near-duplicate. When a repeat carries an owner/due the first mention
    lacked, that detail is kept."""
    merged: List[dict] = []
    by_key: dict = {}
    for items in per_chunk:
        for item in items:
            key = _dedupe_key(item["text"])
            existing = by_key.get(key)
            if existing is None:
                entry = dict(item)
                by_key[key] = entry
                merged.append(entry)
                continue
            if existing["owner"] is None and item["owner"] is not None:
                existing["owner"] = item["owner"]
            if existing["due"] is None and item["due"] is not None:
                existing["due"] = item["due"]
    return merged


def extract_action_items(
    raw_txt_path,
    model=DEFAULT_MODEL,
    max_chars: Optional[int] = None,
    num_ctx: int = 8192,
    num_predict: int = 400,
    temperature: float = 0.2,
    client=None,
    on_progress=None,
) -> Optional[List[dict]]:
    """Ask the model for action items as structured JSON.

    A local ~4B model WILL sometimes return malformed JSON, JSON wrapped in
    prose, or a shape missing the fields asked for -- this is designed
    around that failure mode explicitly, not just "ask for JSON":

      1. Ask once, using Ollama's JSON mode plus a schema reminder, and try
         to parse the response.
      2. On parse failure, retry ONCE with a stricter prompt that calls out
         the previous failure and demands JSON with no surrounding text.
      3. If that also fails to parse, return None. The caller (server.py)
         must treat None as "no structured data for this session" and fall
         back to the existing prose `notes` rendering -- never surface a
         broken/empty checklist or an error to the user.

    A transcript too long for one call is split into chunks (see
    _split_transcript) and steps 1-2 run per chunk; the results are merged
    in order and de-duplicated. If ANY chunk fails both attempts, the whole
    call returns None: a checklist silently missing one part of the meeting
    is exactly the bug chunking fixes, while the prose notes' own "Action
    Items" section still covers everything.

    A transport-level failure (Ollama unreachable, timeout, etc.) is NOT
    retried here -- it propagates immediately, same as `complete()`, so the
    caller's single try/except fallback handles it uniformly with every
    other summarization failure.

    Returns a list of {"text", "owner", "due"} dicts (possibly empty, if the
    model legitimately found no action items), or None if both attempts
    failed to produce parseable structured data.
    """
    active_client = client if client is not None else _client
    # Ollama only: a custom provider's /models is optional (see
    # llm_provider.OpenAICompatClient.list), so its real call below is the
    # check -- and fails with the provider's real error.
    if client is None:
        _assert_ollama_up()

    transcript = Path(raw_txt_path).read_text(encoding="utf-8")

    base_system_prompt = (
        "You are a precise meeting-notes assistant extracting action items "
        "as JSON.\n"
        "- Respond with ONLY a single JSON object, no prose before or after, "
        "no markdown code fences.\n"
        "- Shape: " + _ACTION_ITEMS_SCHEMA_HINT + "\n"
        '- If there are no action items, return {"action_items": []}.\n'
        "- Only set \"owner\" or \"due\" when a name or date is actually "
        "stated in the transcript -- use null rather than guessing or "
        "inventing one.\n"
        "- Do not quote or reproduce the transcript verbatim."
    )
    strict_system_prompt = (
        base_system_prompt + "\n"
        "- STRICT MODE: your previous response was not valid JSON. Output "
        "ONLY valid JSON this time -- no markdown code fences, no "
        "explanation, no leading or trailing text of any kind."
    )

    # Sized from the context like complete(), against the longer (strict)
    # prompt so the retry can never overflow where the first attempt fit.
    budget = _transcript_char_budget(num_ctx, num_predict, len(strict_system_prompt) + 300)
    if max_chars is not None:
        budget = min(budget, int(max_chars))
    chunks = _split_transcript(transcript, budget) if transcript else [""]
    # Past _MAX_CHUNKS the summary gets a visible coverage notice; a bare
    # checklist has nowhere to show one, so fall back to the prose notes.
    if len(chunks) > _MAX_CHUNKS:
        return None

    options = {
        "temperature": float(temperature),
        "num_predict": int(num_predict),
        "num_ctx": int(num_ctx),
    }

    per_chunk: List[List[dict]] = []
    for i, chunk in enumerate(chunks):
        if len(chunks) > 1:
            header = (
                f"This is part {i + 1} of {len(chunks)} of a longer meeting transcript. "
                "Extract only the action items stated in this part.\n\n"
            )
        else:
            header = "Extract action items from this transcript as JSON.\n\n"
        user_prompt = header + "Transcript (do not quote directly):\n\"\"\"" + chunk + "\"\"\"\n"

        parsed = None
        for system_prompt in (base_system_prompt, strict_system_prompt):
            messages = [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ]
            resp = active_client.chat(
                model=model, messages=messages, options=options, stream=False, format="json"
            )
            content = resp["message"]["content"].strip()
            parsed = _parse_action_items(content)
            if parsed is not None:
                break
        if parsed is None:
            return None
        per_chunk.append(parsed)
        if len(chunks) > 1:
            _report(on_progress, i + 1, len(chunks))

    if len(per_chunk) == 1:
        return per_chunk[0]
    return _merge_action_items(per_chunk)
