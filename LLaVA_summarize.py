from pathlib import Path
import ollama
import base64, io, time
from PIL import Image

DEFAULT_MODEL = "llava:latest"

def _assert_ollama_up():
    # Quick connectivity check; will raise if server isn’t up
    ollama.list()

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

def complete(
    raw_txt_path, 
    out_path=None, 
    model=DEFAULT_MODEL, 
    frame_paths=None,      # list of image paths
    max_images=4,          # keep it small
    max_image_px=1280,     # downscale large frames
    jpeg_quality=80,       # compress
    max_chars=12000,       # trim long transcripts
    stream=False,          # set True to avoid “stuck” feel
    num_ctx=8192,          # give LLaVA more room
    num_predict=800,
    temperature=0.3,
    on_token=None, ):

    _assert_ollama_up()

    transcript = Path(raw_txt_path).read_text(encoding="utf-8")

    system_prompt = (
        "You are a precise meeting-notes assistant.\n"
        "- Output ONLY valid Markdown.\n"
        "- Fill EVERY section of the template; if unknown, leave the section but put '- (none)'.\n"
        "- DO NOT quote or reproduce the transcript verbatim (no long paragraphs copied).\n"
        "- Use short bullets with concrete nouns/verbs; keep each bullet ≤ 20 words.\n"
        "- Never include the raw transcript in your answer."
    )

    template = ("# Title\n"
        "- One-liner purpose of meeting\n\n"
        "## Key Points\n- (bullet)\n- (bullet)\n\n"
        "## Decisions\n- (decision)\n\n"
        "## Action Items\n- [Owner] task — due date\n\n"
        "## Open Questions\n- (question)\n\n"
        "## Timeline / Dates Mentioned\n- (item)\n"
        )

    user_prompt = (
        "Summarize the following transcript into the template below.\n\n"
        "Transcript (do not quote directly):\n"
        f"\"\"\"{transcript}\"\"\"\n\n"
        f"Template:\n{template}"
    )

    images = []
    if frame_paths:
        for p in list(frame_paths)[:max_images]:
            images.append(_img_to_b64_resized(p, max_px=max_image_px, jpeg_quality=jpeg_quality))

    kwargs = dict(
        model=model,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt, **({"images": images} if images else {})},
        ],
        options={
            "temperature": float(temperature),
            "num_predict": int(num_predict),
            "num_ctx": int(num_ctx),
        },
        stream=bool(stream),
    )

    if stream:
        parts = []
        for chunk in ollama.chat(**kwargs):
            delta = chunk.get("message", {}).get("content", "")
            if delta:
                parts.append(delta)
                if on_token:
                    on_token(delta)
        md = "".join(parts).strip()
    else:
        resp = ollama.chat(**kwargs)
        md = resp["message"]["content"].strip()

    if out_path:
        Path(out_path).write_text(md, encoding="utf-8")

    return md